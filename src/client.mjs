import { NanoodleError } from "./errors.mjs";
import { b64ImageMime, bytesToDataUrl, dataUrlBytes, MEDIA_INLINE_MAX } from "./media.mjs";

const AUDIO_MIME = { mp3: "audio/mpeg", opus: "audio/ogg", aac: "audio/aac", flac: "audio/flac", wav: "audio/wav", pcm: "audio/wav" };

/** Map an HTTP failure to an actionable error (mirrors the app's httpRunError). Never leaks the key. */
export function httpError(status, bodyText) {
  if (status === 401 || status === 403) {
    return new NanoodleError(`API key rejected (HTTP ${status}) — check your NanoGPT key / NANOGPT_API_KEY`, { code: "auth", status });
  }
  if (status === 402 || /insufficient|balance|funds|not enough|payment required/i.test(String(bodyText || ""))) {
    return new NanoodleError("out of balance — this run needs more credit. Top up at nano-gpt.com, then run again.", { code: "funds", status });
  }
  return new NanoodleError(status + ": " + String(bodyText).slice(0, 160), { code: "http", status });
}

/**
 * Cost extraction (mirrors the app's costFromJson). USD priority:
 * j.cost (>0) → x_nanogpt_pricing.(costUsd|cost|amount) → metadata.cost → j.cost even when 0.
 * Present-but-zero = known-free (kept); absent = unknown.
 */
export function costFromJson(j) {
  if (!j) return { usd: null, balance: null };
  const p = j.x_nanogpt_pricing;
  const pUsd = p && (p.costUsd != null ? p.costUsd : p.cost != null ? p.cost : p.amount);
  const mUsd = j.metadata && j.metadata.cost;
  const usd = typeof j.cost === "number" && j.cost > 0 ? j.cost
    : pUsd != null && isFinite(Number(pUsd)) ? Number(pUsd)
    : mUsd != null && isFinite(Number(mUsd)) ? Number(mUsd)
    : typeof j.cost === "number" ? j.cost
    : null;
  const balance = typeof j.remainingBalance === "number" ? j.remainingBalance
    : p && typeof p.remainingBalance === "number" ? p.remainingBalance
    : null;
  return { usd, balance };
}

/** Header-borne cost/balance (binary audio path): x-cost / x-nano-cost, x-remaining-balance. */
export function costFromHeaders(r) {
  const g = (k) => (r && r.headers && r.headers.get ? r.headers.get(k) : null);
  const c = parseFloat(g("x-cost") || g("x-nano-cost") || "");
  const b = parseFloat(g("x-remaining-balance") || "");
  return { usd: isNaN(c) ? null : c, balance: isNaN(b) ? null : b };
}

/** JSON cost wins for usd; the x-remaining-balance header wins for balance. */
export function costWithHeaders(j, r) {
  const fromJson = costFromJson(j);
  const fromHeaders = costFromHeaders(r);
  return {
    usd: fromJson.usd != null ? fromJson.usd : fromHeaders.usd,
    balance: fromHeaders.balance != null ? fromHeaders.balance : fromJson.balance,
  };
}

function abortError(reason) {
  return reason instanceof Error ? reason : new NanoodleError(reason ? String(reason) : "run aborted", { code: "aborted" });
}

/** Abortable sleep. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError(signal.reason));
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() { clearTimeout(t); reject(abortError(signal.reason)); }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * NanoGPT transport. `baseUrl` and `fetch` are injectable (that's how the offline test harness runs);
 * pollIntervals / timeouts are per-media-kind knobs (ms).
 */
export class NanoClient {
  constructor({ apiKey, baseUrl = "https://nano-gpt.com", fetch = globalThis.fetch, pollIntervals = {}, timeouts = {} } = {}) {
    // non-enumerable: console.log/util.inspect/JSON.stringify of a client (or a Workflow holding
    // one) must never print the key
    Object.defineProperty(this, "apiKey", { value: apiKey, writable: true, enumerable: false, configurable: true });
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetch = fetch;
    this.pollIntervals = { video: 5000, audio: 3000, ...pollIntervals };
    this.timeouts = { video: 600000, audio: 300000, ...timeouts };
  }

  _auth() { return { Authorization: "Bearer " + this.apiKey, "x-api-key": this.apiKey }; }

  async _postJson(path, body, signal) {
    const payload = JSON.stringify(body);
    if (payload.length > MEDIA_INLINE_MAX) {
      throw new NanoodleError("request body is too large (~4 MB max) — nanoodle sends media inline as base64; use smaller/shorter media");
    }
    return this.fetch(this.baseUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this._auth() },
      body: payload,
      signal,
    });
  }

  async _get(path, signal) {
    return this.fetch(this.baseUrl + path, { headers: this._auth(), signal });
  }

  /** POST /api/v1/chat/completions (non-streaming). Returns the assistant text. */
  async chat(messages, model, opts = {}, { onCost, signal } = {}) {
    const body = { model, messages };
    body.temperature = opts.temperature != null && opts.temperature !== "" ? +opts.temperature : 0.8;
    if (opts.max_tokens) body.max_tokens = +opts.max_tokens;
    if (opts.response_format) body.response_format = opts.response_format;
    if (opts.reasoning_effort) body.reasoning_effort = opts.reasoning_effort;
    const r = await this._postJson("/api/v1/chat/completions", body, signal);
    if (!r.ok) throw httpError(r.status, await r.text());
    const j = await r.json();
    if (onCost) onCost(costWithHeaders(j, r));
    const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    const txt = msg.content;
    if (txt == null || txt === "") throw new NanoodleError("no text in response");
    let out = typeof txt === "string" ? txt : txt.map((p) => p.text || "").join("");
    if (opts.showThinking && msg.reasoning) {
      out = "```thinking\n" + msg.reasoning + "\n```\n\n" + out;
    }
    return out;
  }

  /** Draw-node twin of chat(): the model answers with images in message.images[]. */
  async chatImage(messages, model, opts = {}, { onCost, signal } = {}) {
    const body = { model, messages };
    body.temperature = opts.temperature != null && opts.temperature !== "" ? +opts.temperature : 0.8;
    const r = await this._postJson("/api/v1/chat/completions", body, signal);
    if (!r.ok) throw httpError(r.status, await r.text());
    const j = await r.json();
    if (onCost) onCost(costWithHeaders(j, r));
    const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    const images = (msg.images || [])
      .map((im) => (im && im.image_url && im.image_url.url) || (im && im.url) || (typeof im === "string" ? im : null))
      .filter(Boolean);
    const text = typeof msg.content === "string" ? msg.content
      : Array.isArray(msg.content) ? msg.content.map((p) => p.text || "").join("") : "";
    if (!images.length) {
      throw new NanoodleError(text ? "this model replied with text, not an image — pick an image-output model" : "no image in response");
    }
    return { images, text, reasoning: msg.reasoning || "" };
  }

  /** POST /v1/images/generations (NOTE: not /api/v1). Returns data: / https URL(s). */
  async image({ prompt, model, size, imageDataUrl, maskDataUrl, extra, n = 1, multi = false }, { onCost, signal } = {}) {
    const body = { model, size: size || "1024x1024", n, response_format: "b64_json" };
    if (prompt) body.prompt = prompt; // omit when blank — upscalers run with no instruction
    if (imageDataUrl) body.imageDataUrl = imageDataUrl; // string OR array (edit multi-reference)
    if (maskDataUrl) body.maskDataUrl = maskDataUrl; // white = repaint
    if (extra) Object.assign(body, extra);
    const r = await this._postJson("/v1/images/generations", body, signal);
    if (!r.ok) throw httpError(r.status, await r.text());
    const j = await r.json();
    const urls = (j.data || [])
      .map((d) => (d.b64_json ? "data:" + b64ImageMime(d.b64_json) + ";base64," + d.b64_json : d.url))
      .filter(Boolean);
    if (!urls.length) throw new NanoodleError("no image in response");
    if (onCost) onCost(costWithHeaders(j, r));
    return multi ? urls : urls[0];
  }

  /** POST /api/generate-video then poll GET /api/video/status?requestId= until COMPLETED. */
  async video(model, prompt, opts = {}, imageDataUrl, { onCost, onPoll, signal } = {}) {
    const body = { model, prompt };
    if (opts.duration) body.duration = opts.duration;
    if (opts.aspect_ratio) body.aspect_ratio = opts.aspect_ratio;
    if (opts.resolution) body.resolution = opts.resolution;
    if (imageDataUrl) body.imageDataUrl = imageDataUrl;
    if (opts.last_image) body.last_image = opts.last_image;
    if (opts.videoUrl) body.videoUrl = opts.videoUrl;
    if (opts.videoDataUrl) body.videoDataUrl = opts.videoDataUrl;
    if (opts.audioUrl) body.audioUrl = opts.audioUrl;
    if (opts.audioDataUrl) body.audioDataUrl = opts.audioDataUrl;
    if (opts.lora) Object.assign(body, opts.lora); // LoRA params (lora_url_1.. for LTX video)
    if (opts.extra) Object.assign(body, opts.extra); // fields.modelOpts — per-model knobs incl. seed
    // node-owned dims win over stale modelOpts copies (twin of the app runtime)
    if (opts.duration) body.duration = opts.duration;
    if (opts.aspect_ratio) body.aspect_ratio = opts.aspect_ratio;
    if (opts.resolution) body.resolution = opts.resolution;
    if (opts.refImages && opts.refImages.length) body[opts.refKey || "reference_images"] = opts.refImages; // wired refs win last
    const r = await this._postJson("/api/generate-video", body, signal);
    if (!r.ok) throw httpError(r.status, await r.text());
    const j = await r.json();
    if (onCost) onCost(costWithHeaders(j, r));
    const runId = j.runId || j.id;
    if (!runId) throw new NanoodleError("no runId returned");

    const t0 = Date.now();
    while (Date.now() - t0 < this.timeouts.video) {
      await sleep(this.pollIntervals.video, signal);
      let s;
      try {
        s = await (await this._get("/api/video/status?requestId=" + encodeURIComponent(runId), signal)).json();
      } catch (e) {
        if (signal && signal.aborted) throw abortError(signal.reason);
        continue; // transient poll failure — keep polling until timeout
      }
      const st = String((s.data && s.data.status) || s.status || "").toUpperCase();
      if (onPoll) onPoll({ status: st, elapsedMs: Date.now() - t0, runId });
      if (st === "COMPLETED" || st === "SUCCEEDED") {
        const out = (s.data && s.data.output) || s.output || {};
        const url = (out.video && out.video.url) || out.url || (Array.isArray(out.video) ? out.video[0] && out.video[0].url : null);
        if (!url) throw new NanoodleError("completed but no video url");
        return url;
      }
      if (["FAILED", "ERROR", "CANCELED"].includes(st)) {
        throw new NanoodleError("video failed: " + ((s.data && s.data.error) || st));
      }
    }
    throw new NanoodleError(`video timed out (${Math.round(this.timeouts.video / 1000)}s) — the job may still be running on NanoGPT's side`, { code: "timeout" });
  }

  /** POST /api/v1/audio/speech (music + tts + remix). Returns an audio URL (https or data:). */
  async audio(model, input, extra = {}, { onCost, onPoll, signal } = {}) {
    const body = Object.assign({ model, input }, extra);
    const r = await this._postJson("/api/v1/audio/speech", body, signal);
    if (!r.ok) throw httpError(r.status, await r.text());
    const ct = (r.headers && r.headers.get && r.headers.get("content-type")) || "";
    if (ct.includes("application/json")) {
      const j = await r.json();
      if (onCost) onCost(costWithHeaders(j, r));
      let url = j.url || j.audioUrl || (j.data && j.data.url) || (j.data && j.data.audioUrl);
      if (!url && (j.runId || j.id)) url = await this._pollAudio(model, j, { onPoll, signal });
      if (!url) throw new NanoodleError("no audio url in response");
      return url;
    }
    // binary body → the audio bytes; MIME from content-type, pinned from the requested format when generic
    if (onCost) onCost(costFromHeaders(r));
    const bytes = new Uint8Array(await r.arrayBuffer());
    let mime = ct.split(";")[0].trim().toLowerCase();
    if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") {
      mime = AUDIO_MIME[extra.response_format || "mp3"] || "audio/mpeg";
    }
    return bytesToDataUrl(bytes, mime);
  }

  async _pollAudio(model, j, { onPoll, signal } = {}) {
    const runId = j.runId || j.id;
    const qs = new URLSearchParams({ runId: String(runId), model });
    if (j.cost != null) qs.set("cost", String(j.cost)); // lets the server auto-refund on failure
    if (j.paymentSource) qs.set("paymentSource", String(j.paymentSource));
    if (j.isApiRequest != null) qs.set("isApiRequest", String(j.isApiRequest));
    const t0 = Date.now();
    while (Date.now() - t0 < this.timeouts.audio) {
      await sleep(this.pollIntervals.audio, signal);
      let s;
      try {
        s = await (await this._get("/api/tts/status?" + qs, signal)).json();
      } catch (e) {
        if (signal && signal.aborted) throw abortError(signal.reason);
        continue;
      }
      const st = String(s.status || "").toLowerCase();
      if (onPoll) onPoll({ status: st, elapsedMs: Date.now() - t0, runId, queuePosition: s.queuePosition });
      if (st === "completed" || st === "succeeded") {
        const url = s.audioUrl || s.url || (s.data && s.data.audioUrl) || (s.data && s.data.url);
        if (!url) throw new NanoodleError("completed but no audio url");
        return url;
      }
      if (["error", "failed", "content_policy_violation"].includes(st)) {
        throw new NanoodleError("audio failed: " + (s.error || s.message || st));
      }
    }
    throw new NanoodleError(`audio timed out (${Math.round(this.timeouts.audio / 1000)}s) — the job may still be running on NanoGPT's side`, { code: "timeout" });
  }

  /** POST /api/v1/audio/transcriptions (multipart; the audio form field MUST be "file"). */
  async transcribe(model, audioUrl, language, { onCost, signal } = {}) {
    let bytes, mime;
    if (/^data:/i.test(audioUrl)) {
      ({ bytes, mime } = dataUrlBytes(audioUrl));
    } else {
      const r = await this.fetch(audioUrl, { signal }); // media CDN — no auth headers
      if (!r.ok) throw new NanoodleError("couldn't download the audio to transcribe (" + r.status + ")");
      bytes = new Uint8Array(await r.arrayBuffer());
      mime = ((r.headers && r.headers.get && r.headers.get("content-type")) || "audio/mpeg").split(";")[0];
    }
    if (bytes.length > 3.5 * 1024 * 1024) {
      throw new NanoodleError("this clip is too big to transcribe directly (~3.5 MB max) — nanoodle sends audio inline; use a shorter clip");
    }
    const ext = ((mime || "audio/mp3").split("/")[1] || "mp3").split(";")[0];
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: mime || "audio/mpeg" }), "audio." + ext);
    fd.append("model", model);
    if (language) fd.append("language", language);
    // no explicit Content-Type — fetch sets the multipart boundary
    const r = await this.fetch(this.baseUrl + "/api/v1/audio/transcriptions", { method: "POST", headers: this._auth(), body: fd, signal });
    if (!r.ok) throw httpError(r.status, await r.text());
    const j = await r.json();
    if (onCost) onCost(costWithHeaders(j, r));
    const txt = j.transcription != null ? j.transcription
      : j.text != null ? j.text
      : j.data && (j.data.transcription != null ? j.data.transcription : j.data.text);
    if (txt == null) throw new NanoodleError("no transcription in response");
    return txt;
  }

  /**
   * Download hosted media (CDN — no auth headers) and inline it as a data: URL.
   * Used when a chat audio part needs base64 bytes but the upstream node produced an https URL.
   */
  async fetchMediaDataUrl(url, { signal } = {}) {
    const r = await this.fetch(url, { signal });
    if (!r.ok) throw new NanoodleError("couldn't download media to inline (" + r.status + "): " + url);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const ct = (((r.headers && r.headers.get && r.headers.get("content-type")) || "").split(";")[0] || "").trim().toLowerCase();
    const mime = ct && ct !== "application/octet-stream" && ct !== "binary/octet-stream" ? ct : undefined;
    return bytesToDataUrl(bytes, mime); // sniffs magic bytes when the CDN's content-type is generic
  }

  /** Optional helper: POST /api/check-balance → { usd_balance }. */
  async checkBalance(signal) {
    const r = await this._postJson("/api/check-balance", {}, signal);
    if (!r.ok) throw httpError(r.status, await r.text());
    return r.json();
  }
}
