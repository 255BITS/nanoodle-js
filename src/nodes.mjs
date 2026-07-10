import { NanoodleError, UnsupportedNodeError } from "./errors.mjs";
import { IMG_PORT_RE, EDIT_IMG_RE, REF_PORT_RE, displayName } from "./graph.mjs";
import { MEDIA_INLINE_MAX } from "./media.mjs";

/** Message for browser-only media nodes (exact wording is part of the contract). */
export function unsupportedNodeError(node) {
  return new UnsupportedNodeError(
    `node "${displayName(node)}" (${node.id}): node type '${node.type}' does local media processing that requires ` +
    "the nanoodle browser app; not supported by this library yet",
    { nodeId: node.id, nodeType: node.type });
}

function mdl(n) {
  const m = String((n.fields && n.fields.model) || "").trim();
  if (!m) throw new NanoodleError(`pick a model first (node ${n.id})`);
  return m; // model strings pass through VERBATIM — endpoint choice is by node TYPE
}

function portIdx(name) {
  const m = /(\d+)$/.exec(name);
  return m ? +m[1] : 1;
}

function collectPorts(inp, re) {
  return Object.keys(inp)
    .filter((k) => re.test(k))
    .sort((a, b) => portIdx(a) - portIdx(b))
    .map((k) => inp[k])
    .filter(Boolean);
}

function promptOf(n, inp, errMsg) {
  const raw = inp.prompt != null ? inp.prompt : n.fields.prompt != null ? n.fields.prompt : "";
  const p = String(raw).trim();
  if (!p && errMsg) throw new NanoodleError(errMsg);
  return p;
}

/** Wired audio data: URL → OpenAI-style inline input_audio part (base64 body, no data: prefix). */
function audioInputPart(url) {
  if (typeof url !== "string" || !url) return null;
  if (url.length > MEDIA_INLINE_MAX) {
    throw new NanoodleError("audio clip is too large to inline (~4 MB send limit) — use a shorter clip");
  }
  const comma = url.indexOf(",");
  const head = comma >= 0 ? url.slice(0, comma) : "";
  const data = comma >= 0 ? url.slice(comma + 1) : url;
  const mt = head.match(/data:([^;]+)/);
  let fmt = ((mt && mt[1] ? mt[1].split("/")[1] : "") || "wav").toLowerCase();
  if (fmt === "mpeg" || fmt === "mp3") fmt = "mp3";
  else if (fmt === "x-wav" || fmt === "wave") fmt = "wav";
  return { type: "input_audio", input_audio: { data, format: fmt } };
}

function llmOpts(n) {
  const f = n.fields, o = {};
  if (f.temperature != null && f.temperature !== "") o.temperature = +f.temperature;
  if (f.maxTokens) o.max_tokens = +f.maxTokens;
  if (f.format === "JSON") o.response_format = { type: "json_object" };
  if (f.reasoningEffort && f.reasoningEffort !== "default") o.reasoning_effort = f.reasoningEffort;
  if (f.showThinking === true || f.showThinking === "true") o.showThinking = true;
  return o;
}

/** Per-call image extras: fixed seed (when numeric) + custom-civitai AIR. */
function imgExtra(n) {
  const e = {};
  const s = n.fields.seed;
  if (s != null && String(s).trim() !== "" && !isNaN(Number(s))) e.seed = Number(s);
  if (n.fields.model === "custom-civitai") {
    const air = String(n.fields.customCivitaiAir || "").trim();
    if (!air) throw new NanoodleError("select a CivitAI model — use AIR format civitai:modelId@versionId");
    e.customCivitaiAir = air;
  }
  return e;
}

/** Video dims under the standard wire names (no catalog in v1 → no per-model renames). */
function videoDims(n) {
  const out = {};
  const f = n.fields;
  if (f.resolution != null && f.resolution !== "") out.resolution = f.resolution;
  if (f.aspect != null && f.aspect !== "") out.aspect_ratio = f.aspect;
  if (f.duration != null && f.duration !== "") out.duration = f.duration;
  return out;
}

function videoSourceOpts(url) {
  return /^https?:/i.test(url) ? { videoUrl: url } : { videoDataUrl: url };
}

function audioSourceOpts(url) {
  return /^https?:/i.test(url) ? { audioUrl: url } : { audioDataUrl: url };
}

const nonEmpty = (v) => v != null && String(v).trim() !== "";

/**
 * Faithful to the app's collectAudioParams: only-when-nonempty, defaults omitted,
 * then fields.extraJson merged verbatim last. (Catalog gating: skipped in v1.)
 */
function audioParams(n) {
  const f = n.fields, body = {};
  const num = (v) => { const x = Number(v); return isNaN(x) ? null : x; };
  if (n.type === "music") {
    if (nonEmpty(f.lyrics)) body.lyrics = f.lyrics;
    if (f.instrumental === true || f.instrumental === "true") body.instrumental = true;
    if (nonEmpty(f.duration) && num(f.duration) != null) body.duration = num(f.duration);
    if (nonEmpty(f.negative_prompt)) body.negative_prompt = f.negative_prompt;
    if (nonEmpty(f.seed) && num(f.seed) != null) body.seed = num(f.seed);
    if (nonEmpty(f.response_format) && f.response_format !== "mp3") body.response_format = f.response_format;
  } else if (n.type === "tts") {
    if (nonEmpty(f.voice)) body.voice = f.voice;
    if (nonEmpty(f.speed) && num(f.speed) != null && num(f.speed) !== 1) body.speed = num(f.speed); // omit when 1
    if (nonEmpty(f.instructions)) body.instructions = f.instructions;
    if (nonEmpty(f.response_format) && f.response_format !== "mp3") body.response_format = f.response_format;
  } else if (n.type === "remix") {
    if (nonEmpty(f.lyrics)) body.lyrics = f.lyrics;
    if (nonEmpty(f.duration) && num(f.duration) != null) body.duration = num(f.duration);
    if (nonEmpty(f.response_format) && f.response_format !== "mp3") body.response_format = f.response_format;
  }
  if ((f.extraJson || "").trim()) {
    try { Object.assign(body, JSON.parse(f.extraJson)); }
    catch { throw new NanoodleError("advanced params: invalid JSON in extraJson"); }
  }
  return body;
}

function chatMessages(n, prompt, imgs, audioPart) {
  const messages = [];
  if ((n.fields.system || "").trim()) messages.push({ role: "system", content: n.fields.system.trim() });
  messages.push(imgs.length || audioPart
    ? {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...imgs.map((url) => ({ type: "image_url", image_url: { url } })),
          ...(audioPart ? [audioPart] : []),
        ],
      }
    : { role: "user", content: prompt });
  return messages;
}

function guardRefsSize(imgs) {
  if (imgs.reduce((s, u) => s + (u ? u.length : 0), 0) > MEDIA_INLINE_MAX) {
    throw new NanoodleError("reference images too large (~4 MB combined limit) — use fewer or smaller images");
  }
}

/**
 * Per-node executors. Each: async run(node, inp, ctx) → out map keyed by output port name.
 * `node.fields` already carries wired field overrides + user inputs + settings.
 * ctx = { chat, chatImage, image, video, audio, transcribe, progress } (cost/poll wired by the engine).
 */
export const RUNNERS = {
  async text(n) { return { text: n.fields.text || "" }; },

  async upload(n) {
    if (!n.fields.image) throw new NanoodleError("no image — this Image input has no image");
    return { image: n.fields.image };
  },
  async aupload(n) {
    if (!n.fields.audio) throw new NanoodleError("no audio — this Audio input has no clip");
    return { audio: n.fields.audio };
  },
  async vupload(n) {
    if (!n.fields.video) throw new NanoodleError("no video — this Video input has no clip");
    return { video: n.fields.video };
  },

  async choice(n) {
    const opts = String(n.fields.options || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const sel = n.fields.selected;
    const val = sel != null && opts.indexOf(sel) >= 0 ? sel : opts[0] || "";
    if (!val) throw new NanoodleError("no options — this Choice has no options to pick from");
    return { text: val };
  },

  async join(n, inp) {
    const sep = (n.fields.sep != null ? n.fields.sep : " ").replace(/\\n/g, "\n");
    return { text: [inp.a, inp.b].filter((v) => v != null && v !== "").join(sep) };
  },

  async llm(n, inp, ctx) {
    const prompt = promptOf(n, inp, "no prompt");
    const imgs = collectPorts(inp, IMG_PORT_RE);
    const audioPart = inp.audio ? audioInputPart(inp.audio) : null;
    const messages = chatMessages(n, prompt, imgs, audioPart);
    return { text: await ctx.chat(messages, mdl(n), llmOpts(n)) };
  },

  async vision(n, inp, ctx) {
    if (!inp.image) throw new NanoodleError("no image input");
    const q = (n.fields.q || "Describe this image.").trim();
    const messages = [{
      role: "user",
      content: [{ type: "text", text: q }, { type: "image_url", image_url: { url: inp.image } }],
    }];
    return { text: await ctx.chat(messages, mdl(n), {}) };
  },

  async image(n, inp, ctx) {
    const prompt = promptOf(n, inp, "no prompt");
    const want = Math.max(1, parseInt(n.fields.variations, 10) || 1);
    const urls = await ctx.image({ prompt, model: mdl(n), size: n.fields.size || "1024x1024", extra: imgExtra(n), n: want, multi: true });
    const sel = Math.min(Math.max(0, parseInt(n.fields.sel, 10) || 0), urls.length - 1);
    return { image: urls[sel], images: urls };
  },

  async edit(n, inp, ctx) {
    const imgs = collectPorts(inp, EDIT_IMG_RE);
    if (!imgs.length) throw new NanoodleError("no image input");
    const prompt = promptOf(n, inp);
    if (!prompt && !/upscal/i.test(n.fields.model || "")) throw new NanoodleError("no edit instruction");
    guardRefsSize(imgs);
    const src = imgs.length > 1 ? imgs : imgs[0]; // array → multi-image composite; string → single edit
    return { image: await ctx.image({ prompt, model: mdl(n), size: n.fields.size || "1024x1024", imageDataUrl: src, extra: imgExtra(n) }) };
  },

  async draw(n, inp, ctx) {
    const prompt = promptOf(n, inp, "no prompt");
    const imgs = collectPorts(inp, IMG_PORT_RE);
    guardRefsSize(imgs);
    const messages = chatMessages(n, prompt, imgs, null);
    const res = await ctx.chatImage(messages, mdl(n), {});
    const sel = Math.min(Math.max(0, parseInt(n.fields.sel, 10) || 0), res.images.length - 1);
    const showThinking = n.fields.showThinking !== false && n.fields.showThinking !== "false";
    const text = showThinking && res.reasoning
      ? "```thinking\n" + res.reasoning + "\n```\n\n" + (res.text || "")
      : res.text;
    return { image: res.images[sel], images: res.images, text };
  },

  async inpaint(n, inp, ctx) {
    const source = inp.image != null ? inp.image : n.fields.image;
    const mask = inp.mask != null ? inp.mask : n.fields.mask;
    if (!source) throw new NanoodleError("no image — supply the image to repaint");
    if (!mask) throw new NanoodleError("no mask — supply a B/W mask (white = repaint)");
    const prompt = promptOf(n, inp, "no prompt — say what to paint into the masked area");
    // v1 caveat: the browser app composites the mask onto black at source size; here it passes through verbatim
    return { image: await ctx.image({ prompt, model: mdl(n), size: n.fields.size || "1024x1024", imageDataUrl: source, maskDataUrl: mask, extra: imgExtra(n) }) };
  },

  async tvideo(n, inp, ctx) {
    const prompt = promptOf(n, inp, "no prompt");
    const opts = { ...videoDims(n), extra: n.fields.modelOpts || {} };
    const refs = collectPorts(inp, REF_PORT_RE);
    if (refs.length) { opts.refImages = refs; opts.refKey = "reference_images"; }
    return { video: await ctx.video(mdl(n), prompt, opts, null) };
  },

  async ivideo(n, inp, ctx) {
    if (!inp.image) throw new NanoodleError("no image input");
    const prompt = promptOf(n, inp);
    const opts = { ...videoDims(n), extra: n.fields.modelOpts || {} };
    if (inp.endframe) opts.last_image = inp.endframe;
    return { video: await ctx.video(mdl(n), prompt, opts, inp.image) };
  },

  async vedit(n, inp, ctx) {
    if (!inp.video) throw new NanoodleError("no video input");
    const prompt = promptOf(n, inp);
    const opts = { ...videoSourceOpts(inp.video), ...videoDims(n), extra: n.fields.modelOpts || {} };
    return { video: await ctx.video(mdl(n), prompt, opts, null) };
  },

  async lipsync(n, inp, ctx) {
    if (!inp.image) throw new NanoodleError("no image input");
    if (!inp.audio) throw new NanoodleError("no audio input");
    const prompt = promptOf(n, inp);
    const opts = { ...audioSourceOpts(inp.audio), ...videoDims(n), extra: n.fields.modelOpts || {} };
    return { video: await ctx.video(mdl(n), prompt, opts, inp.image) };
  },

  async music(n, inp, ctx) {
    const text = promptOf(n, inp, "no prompt — describe the track");
    return { audio: await ctx.audio(mdl(n), text, audioParams(n)) };
  },

  async tts(n, inp, ctx) {
    const text = promptOf(n, inp, "no text — give the Speech node something to say");
    return { audio: await ctx.audio(mdl(n), text, audioParams(n)) };
  },

  async remix(n, inp, ctx) {
    if (!inp.audio) throw new NanoodleError("no audio — wire a source track into the audio port");
    const text = promptOf(n, inp, "no prompt — describe the cover / extension first");
    const params = audioParams(n);
    // https source rides as-is (providers take hosted URLs); local data: is inlined
    if (/^https?:/i.test(inp.audio)) params.audio = inp.audio;
    else {
      if (inp.audio.length > MEDIA_INLINE_MAX) {
        throw new NanoodleError("source audio is too large to inline (~4 MB send limit) — use a shorter clip");
      }
      params.audio = inp.audio;
    }
    return { audio: await ctx.audio(mdl(n), text, params) };
  },

  async transcribe(n, inp, ctx) {
    if (!inp.audio) throw new NanoodleError("no audio input");
    return { text: await ctx.transcribe(mdl(n), inp.audio, (n.fields.language || "auto").trim()) };
  },
};
