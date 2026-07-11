import { gunzipSync } from "node:zlib";
import { NanoodleError } from "./errors.mjs";

/**
 * Decode-only codec for nanoodle share links — the editor stays the single
 * encoder of record; these functions only ever read.
 *
 * Wire formats (mirrors index.html's loadFromHash / buildShareUrl, locked by
 * the golden fixtures in tests/fixtures/share/ — regenerate them from a real
 * editor with tests/harness/gen-share-fixtures.mjs when the encoder changes):
 *   #g=<b64url(gzip(graph JSON))>          workflow link (editor 🔗 Share)
 *   #j=<b64url(graph JSON)>                uncompressed fallback (no CompressionStream)
 *   #a=<b64url(gzip(app payload))>         app link (play.html); payload = { v, graph, files?, name?, lang?, ... }
 *   #a=u<b64url(app payload)>              uncompressed app fallback ('u' tag inside the value)
 *   #ga=…                                  editor↔play handoff — internal transport, deliberately NOT supported
 */

const URL_RE = /^https?:\/\//i;
const FRAG_RE = /^#?(ga|[gja])=/;

/** True when a string is addressable as a share link: an http(s) URL, or a bare #g=/#j=/#a= fragment. */
export function isShareRef(s) {
  return typeof s === "string" && (URL_RE.test(s) || FRAG_RE.test(s));
}

function b64urlToBuf(s, what) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new NanoodleError(`share link: ${what} payload is not base64url data — is the URL complete?`);
  }
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function parseJson(text, what) {
  try { return JSON.parse(text); }
  catch { throw new NanoodleError(`share link: ${what} payload decoded but is not valid JSON — the link may be truncated`); }
}

function gunzipText(buf, what) {
  try { return gunzipSync(buf).toString("utf8"); }
  catch { throw new NanoodleError(`share link: ${what} payload is not valid gzip data — the link may be truncated`); }
}

/**
 * Decode a share fragment ("#g=…", "g=…", "#a=…", …) to its graph.
 * @returns {{ graph: object, kind: "g"|"j"|"a", app: { name?, lang?, hasFiles: boolean }|null }}
 */
export function decodeShareFragment(fragment) {
  let f = String(fragment);
  if (f.startsWith("#")) f = f.slice(1);
  if (f.startsWith("ga=")) {
    throw new NanoodleError(
      "share link: #ga= is the editor↔app-builder handoff — an internal, unstable format. " +
      "Open the link in a browser and use 🔗 Share to mint a #g= workflow link instead.");
  }
  if (f.startsWith("g=")) {
    return { graph: parseJson(gunzipText(b64urlToBuf(f.slice(2), "#g="), "#g="), "#g="), kind: "g", app: null };
  }
  if (f.startsWith("j=")) {
    return { graph: parseJson(b64urlToBuf(f.slice(2), "#j=").toString("utf8"), "#j="), kind: "j", app: null };
  }
  if (f.startsWith("a=")) {
    const tag = f.slice(2);
    const json = tag[0] === "u"
      ? b64urlToBuf(tag.slice(1), "#a=u").toString("utf8")
      : gunzipText(b64urlToBuf(tag, "#a="), "#a=");
    const payload = parseJson(json, "#a=");
    if (!payload || typeof payload !== "object" || !payload.graph) {
      throw new NanoodleError("share link: #a= app payload has no graph in it");
    }
    // files/samples/lang are play.html presentation — executors run graphs, not apps.
    return {
      graph: payload.graph,
      kind: "a",
      app: {
        ...(typeof payload.name === "string" && payload.name ? { name: payload.name } : {}),
        ...(typeof payload.lang === "string" && payload.lang ? { lang: payload.lang } : {}),
        hasFiles: !!payload.files,
      },
    };
  }
  throw new NanoodleError(`share link: no #g=/#j=/#a= fragment found in "${fragment}"`);
}

function fragmentOf(url) {
  const i = url.indexOf("#");
  return i === -1 ? null : url.slice(i);
}

/**
 * Decode any nanoodle share reference — a full URL, a bare fragment, or a
 * shortener link (da.gd/TinyURL/…) whose redirect target carries the fragment.
 *
 * Direct fragment links decode with ZERO network calls. Only fragment-less
 * http(s) URLs trigger fetches, and those are redirect-header reads with no
 * credentials attached (the codec never sees an API key by construction).
 *
 * @param {string} input
 * @param {{ fetch?: typeof fetch, maxHops?: number }} [opts]
 * @returns {Promise<{ graph: object, kind: "g"|"j"|"a", app: object|null, url: string }>}
 */
export async function decodeShareUrl(input, opts = {}) {
  const s = String(input).trim();
  if (!URL_RE.test(s)) return { ...decodeShareFragment(s), url: s };

  let url = s;
  const frag = fragmentOf(url);
  if (frag && FRAG_RE.test(frag)) return { ...decodeShareFragment(frag), url };

  // No fragment on the URL itself → treat it as a short link and follow
  // redirects by hand: fragments ride in the Location header, which automatic
  // redirect handling would consume before we could read it.
  const f = opts.fetch ?? globalThis.fetch;
  const maxHops = opts.maxHops ?? 5;
  for (let hop = 0; hop < maxHops; hop++) {
    let res;
    try { res = await f(url, { method: "GET", redirect: "manual" }); }
    catch (e) { throw new NanoodleError(`share link: could not resolve ${url}: ${e.message}`); }
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) {
      throw new NanoodleError(
        `share link: ${url} answered ${res.status} with no #g=/#j=/#a= fragment and no redirect — ` +
        "open it in a browser and share the long nanoodle.com URL instead");
    }
    url = new URL(loc, url).href;
    const hopFrag = fragmentOf(url);
    if (hopFrag && FRAG_RE.test(hopFrag)) return { ...decodeShareFragment(hopFrag), url };
  }
  throw new NanoodleError(`share link: gave up after ${maxHops} redirects without finding a share fragment`);
}
