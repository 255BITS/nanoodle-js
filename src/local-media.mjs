/**
 * Local media ops that the browser runs with canvas / Web Audio / MediaRecorder.
 * Headless path: shell out to ffmpeg/ffprobe on PATH (soft dependency — not an npm package).
 *
 * Behaviour mirrors play.html / index.html (resizePlan, trim defaults, vframes seek math,
 * combine concat, soundtrack mux). Outputs are data: URLs so they plug into the existing
 * MediaRef / network-inline pipeline.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { NanoodleError } from "./errors.mjs";
import { bytesToDataUrl, dataUrlBytes, sniffMime, MEDIA_INLINE_MAX } from "./media.mjs";

const MAX_FRAMES = 12;

/* ---------- process helpers ------------------------------------------------ */

function runProc(bin, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    const to = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new NanoodleError(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout = Buffer.concat([stdout, d]); });
    child.stderr.on("data", (d) => { stderr = Buffer.concat([stderr, d]); });
    child.on("error", (e) => {
      clearTimeout(to);
      if (e && e.code === "ENOENT") {
        reject(new NanoodleError(
          `local media nodes need ffmpeg on PATH (not found: ${bin}). ` +
          "Install ffmpeg, or run this graph in the nanoodle browser app."));
      } else reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(to);
      if (code === 0) resolve({ stdout, stderr: stderr.toString("utf8") });
      else reject(new NanoodleError(
        `${bin} failed (exit ${code}): ${(stderr.toString("utf8") || "").trim().slice(-400) || "no stderr"}`));
    });
  });
}

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-media-"));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** data:/https URL (or raw string MediaRef url) → bytes. */
async function urlBytes(url, fetchFn) {
  if (url == null) throw new NanoodleError("no media input");
  const u = typeof url === "object" && url.url != null ? url.url : String(url);
  if (/^data:/i.test(u)) return dataUrlBytes(u).bytes;
  if (/^https?:/i.test(u)) {
    const fetchImpl = fetchFn || globalThis.fetch;
    if (!fetchImpl) throw new NanoodleError("can't download media: no fetch available");
    const r = await fetchImpl(u);
    if (!r.ok) throw new NanoodleError(`couldn't download media (${r.status}): ${u.slice(0, 120)}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  throw new NanoodleError("media must be a data: or http(s) URL");
}

async function writeInput(dir, name, url, fetchFn) {
  const bytes = await urlBytes(url, fetchFn);
  // preserve a sensible extension so ffmpeg picks the demuxer
  let ext = ".bin";
  if (/^data:/i.test(String(typeof url === "object" ? url.url : url))) {
    const mime = sniffMime(bytes);
    ext = mime.includes("png") ? ".png"
      : mime.includes("jpeg") ? ".jpg"
      : mime.includes("webp") ? ".webp"
      : mime.includes("gif") ? ".gif"
      : mime.includes("wav") ? ".wav"
      : mime.includes("mpeg") || mime.includes("mp3") ? ".mp3"
      : mime.includes("mp4") ? ".mp4"
      : mime.includes("webm") ? ".webm"
      : ".bin";
  } else {
    const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(String(typeof url === "object" ? url.url : url));
    if (m) ext = "." + m[1].toLowerCase();
  }
  const path = join(dir, name + ext);
  await writeFile(path, bytes);
  return path;
}

function dataUrlFromFile(path, mimeHint) {
  return readFile(path).then((buf) => {
    const u8 = new Uint8Array(buf);
    const mime = mimeHint || sniffMime(u8);
    return bytesToDataUrl(u8, mime);
  });
}

/* ---------- resizePlan (verbatim from index.html) -------------------------- */

/** @returns {{ cw, ch, dx, dy, dw, dh }|null} */
export function resizePlan(sw, sh, mode, tw, th) {
  if (!(tw > 0) && !(th > 0)) return null;
  if (mode === "fit") {
    let scale;
    if (tw > 0 && th > 0) scale = Math.min(tw / sw, th / sh);
    else if (tw > 0) scale = tw / sw;
    else scale = th / sh;
    if (scale > 1) scale = 1; // never upscale
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    return { cw: w, ch: h, dx: 0, dy: 0, dw: w, dh: h };
  }
  const bw = tw > 0 ? tw : Math.max(1, Math.round(th * sw / sh));
  const bh = th > 0 ? th : Math.max(1, Math.round(tw * sh / sw));
  if (mode === "exact") return { cw: bw, ch: bh, dx: 0, dy: 0, dw: bw, dh: bh };
  // fill & crop: cover, centered
  const scale = Math.max(bw / sw, bh / sh);
  const dw = sw * scale, dh = sh * scale;
  return { cw: bw, ch: bh, dx: (bw - dw) / 2, dy: (bh - dh) / 2, dw, dh };
}

/**
 * Resize/crop an image URL. mode: fit | fill | exact.
 * PNG sources stay PNG (alpha); others → JPEG q≈0.92 (ffmpeg -q:v 2).
 */
export async function resizeCropImage(url, mode, tw, th, { fetch: fetchFn } = {}) {
  const w = Math.max(0, parseInt(tw, 10) || 0);
  const h = Math.max(0, parseInt(th, 10) || 0);
  if (!w && !h) throw new NanoodleError("set a width or height to resize to");
  const m = mode || "fit";

  return withTemp(async (dir) => {
    const inPath = await writeInput(dir, "in", url, fetchFn);
    // probe source size
    const probe = await runProc("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", inPath,
    ]);
    const dims = String(probe.stdout).trim().split("x").map(Number);
    const sw = dims[0], sh = dims[1];
    if (!(sw > 0) || !(sh > 0)) throw new NanoodleError("couldn't read that image to resize");
    const p = resizePlan(sw, sh, m, w, h);
    if (!p) throw new NanoodleError("set a width or height to resize to");

    const srcUrl = typeof url === "object" && url.url != null ? url.url : String(url);
    const wantPng = /^data:image\/png/i.test(srcUrl) || /\.png$/i.test(inPath);
    const outPath = join(dir, wantPng ? "out.png" : "out.jpg");

    // Build a filter that matches canvas drawImage(img, dx, dy, dw, dh) onto cw×ch.
    // For fit: scale to dw×dh (equals cw×ch). For exact: scale stretch. For fill: scale then pad/crop.
    let vf;
    if (m === "fit" || m === "exact") {
      vf = `scale=${p.cw}:${p.ch}`;
    } else {
      // fill: scale so source covers cw×ch, then crop center
      vf = `scale=${p.cw}:${p.ch}:force_original_aspect_ratio=increase,crop=${p.cw}:${p.ch}`;
    }

    const args = ["-y", "-i", inPath, "-vf", vf];
    if (wantPng) args.push("-frames:v", "1", outPath);
    else args.push("-frames:v", "1", "-q:v", "2", outPath);
    await runProc("ffmpeg", args);

    const out = await dataUrlFromFile(outPath, wantPng ? "image/png" : "image/jpeg");
    if (out.length > MEDIA_INLINE_MAX) {
      throw new NanoodleError("resized image is still over the ~4 MB inline limit — pick smaller dimensions");
    }
    return out;
  });
}

/* ---------- audio trim / extract (→ mono WAV) ------------------------------ */

/**
 * Decode audio (or demux audio from video), slice [start, start+len], mono at `rate` Hz → data:audio/wav.
 * len<=0 means "to end" for extract; for trim browser default length is 30 when blank.
 */
export async function trimAudioToWav(url, start, len, rate = 16000, { fetch: fetchFn, wholeIfBlank = false } = {}) {
  return withTemp(async (dir) => {
    const inPath = await writeInput(dir, "in", url, fetchFn);
    const outPath = join(dir, "out.wav");
    const s = Math.max(0, Number(start) || 0);

    // probe duration
    let dur = null;
    try {
      const pr = await runProc("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inPath,
      ]);
      dur = parseFloat(String(pr.stdout).trim());
    } catch { /* some containers lack duration; ffmpeg -t still works */ }

    if (dur != null && isFinite(dur) && s >= dur) {
      throw new NanoodleError(
        `the start point (${Math.round(s * 10) / 10}s) is past the end of this clip, which is only ${dur.toFixed(1)}s long — pick an earlier start`);
    }

    let take;
    if (wholeIfBlank && !(len > 0)) {
      take = dur != null && isFinite(dur) ? Math.max(0.05, dur - s) : null; // null → omit -t
    } else {
      const L = Number.isFinite(Number(len)) && Number(len) > 0 ? Number(len) : 30;
      take = dur != null && isFinite(dur) ? Math.max(0.05, Math.min(L, dur - s)) : L;
    }

    const args = ["-y", "-ss", String(s), "-i", inPath];
    if (take != null) args.push("-t", String(take));
    args.push("-vn", "-ac", "1", "-ar", String(rate || 16000), "-f", "wav", outPath);
    try {
      await runProc("ffmpeg", args);
    } catch (e) {
      const msg = e.message || "";
      if (/does not contain any stream|Output file does not contain|no audio/i.test(msg)
        || /Stream map|matches no streams/i.test(msg)) {
        throw new NanoodleError("this video is silent — generated videos usually have no audio track to extract");
      }
      // decode failures on pure-audio inputs
      if (/Invalid data|could not find codec/i.test(msg)) {
        throw new NanoodleError("couldn't decode that audio for trimming (unsupported format?)");
      }
      throw e;
    }
    return dataUrlFromFile(outPath, "audio/wav");
  });
}

export async function extractAudioToWav(url, start, len, rate = 16000, opts = {}) {
  return trimAudioToWav(url, start, len, rate, { ...opts, wholeIfBlank: true });
}

/* ---------- vframes -------------------------------------------------------- */

export async function extractVideoFrames(url, { count = 1, gap = 0.5, dir = "end", fetch: fetchFn, onProgress } = {}) {
  const n = Math.max(1, Math.min(MAX_FRAMES, parseInt(count, 10) || 1));
  const stepSec = Number.isFinite(Number(gap)) ? Math.max(0, Number(gap)) : 0.5;
  const fromEnd = (dir || "end") === "end";
  const EPS = 0.04;

  return withTemp(async (dir) => {
    const inPath = await writeInput(dir, "in", url, fetchFn);
    const pr = await runProc("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inPath,
    ]);
    const dur = parseFloat(String(pr.stdout).trim());
    if (!isFinite(dur) || dur <= 0) throw new NanoodleError("video has no readable duration");

    const out = {};
    for (let i = 0; i < n; i++) {
      if (onProgress) onProgress(`extracting frame ${i + 1}/${n}…`);
      let t = fromEnd ? (dur - EPS - i * stepSec) : (i * stepSec);
      t = Math.max(0, Math.min(Math.max(0, dur - EPS), t));
      const framePath = join(dir, `f${i + 1}.jpg`);
      await runProc("ffmpeg", [
        "-y", "-ss", String(t), "-i", inPath, "-frames:v", "1", "-q:v", "2", framePath,
      ]);
      out["frame" + (i + 1)] = await dataUrlFromFile(framePath, "image/jpeg");
    }
    return out;
  });
}

/* ---------- combine videos ------------------------------------------------- */

/**
 * Concatenate clips in order. Prefer stream-copy when possible; re-encode on mismatch.
 * `dedup` drops ~1 frame from the start of each clip after the first (seam-frame trim).
 */
export async function concatVideos(urls, dedup = true, { fetch: fetchFn, onProgress } = {}) {
  if (!urls || urls.length < 2) throw new NanoodleError("wire at least two clips to combine");
  return withTemp(async (dir) => {
    const paths = [];
    for (let i = 0; i < urls.length; i++) {
      if (onProgress) onProgress(`loading clip ${i + 1}/${urls.length}…`);
      paths.push(await writeInput(dir, `c${i}`, urls[i], fetchFn));
    }

    // When dedup: trim ~1/30s from the start of clips 2..N (approximate seam-frame drop)
    const prepared = [];
    for (let i = 0; i < paths.length; i++) {
      if (dedup && i > 0) {
        const trimmed = join(dir, `t${i}.mp4`);
        await runProc("ffmpeg", [
          "-y", "-ss", "0.033", "-i", paths[i],
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
          "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", trimmed,
        ]);
        prepared.push(trimmed);
      } else {
        prepared.push(paths[i]);
      }
    }

    const listPath = join(dir, "list.txt");
    const listBody = prepared.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
    await writeFile(listPath, listBody);

    const outPath = join(dir, "out.mp4");
    if (onProgress) onProgress("combining…");
    try {
      // try lossless concat demuxer first
      await runProc("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", outPath,
      ]);
    } catch {
      // re-encode fallback (mismatched codecs/params)
      await runProc("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outPath,
      ]);
    }
    return dataUrlFromFile(outPath, "video/mp4");
  });
}

/* ---------- soundtrack mux ------------------------------------------------- */

/**
 * Replace video audio with the given track. loop=true loops audio to fill video length.
 */
export async function muxSoundtrack(videoUrl, audioUrl, loop = false, { fetch: fetchFn, onProgress } = {}) {
  return withTemp(async (dir) => {
    if (onProgress) onProgress("adding soundtrack…");
    const vPath = await writeInput(dir, "v", videoUrl, fetchFn);
    const aPath = await writeInput(dir, "a", audioUrl, fetchFn);
    const outPath = join(dir, "out.mp4");

    // probe video duration for loop pad
    let vdur = null;
    try {
      const pr = await runProc("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", vPath,
      ]);
      vdur = parseFloat(String(pr.stdout).trim());
    } catch { /* optional */ }

    const args = ["-y", "-i", vPath];
    if (loop) args.push("-stream_loop", "-1");
    args.push("-i", aPath, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k");
    if (loop && vdur != null && isFinite(vdur)) args.push("-t", String(vdur));
    else args.push("-shortest");
    args.push("-movflags", "+faststart", outPath);

    try {
      await runProc("ffmpeg", args);
    } catch (e) {
      // re-encode video if stream copy fails
      const args2 = ["-y", "-i", vPath];
      if (loop) args2.push("-stream_loop", "-1");
      args2.push("-i", aPath, "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "aac", "-b:a", "128k");
      if (loop && vdur != null && isFinite(vdur)) args2.push("-t", String(vdur));
      else args2.push("-shortest");
      args2.push("-movflags", "+faststart", outPath);
      await runProc("ffmpeg", args2);
    }
    return dataUrlFromFile(outPath, "video/mp4");
  });
}

export { MAX_FRAMES };
