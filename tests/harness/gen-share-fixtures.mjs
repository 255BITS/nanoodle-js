#!/usr/bin/env node
/* ======================================================================
   Golden-fixture generator for the share-link decoder (src/share.mjs).

   Boots the REAL nanoodle editor (index.html from a nanoodle checkout)
   headlessly and asks the editor's own encoder — buildShareUrl(),
   packShareFit(), shareableGraph(), bytesToB64url()+gzip() — to mint
   share URLs for known graphs. Each fixture pairs the editor-minted URL
   with the editor's own expected decoded graph, so tests lock our
   decoder to the production wire format, not to our reading of it.

   Zero API spend: the editor is only asked to encode; nothing runs.

   Usage:
     NANOODLE_ROOT=~/dev/nanoodle node tests/harness/gen-share-fixtures.mjs
   Re-run whenever the editor's share encoder changes, and commit the
   regenerated tests/fixtures/share/*.json.
   ====================================================================== */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rm, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PKG_ROOT = normalize(join(HERE, "..", ".."));
const NANOODLE_ROOT = process.env.NANOODLE_ROOT || normalize(join(PKG_ROOT, "..", "nanoodle"));
const OUT_DIR = join(PKG_ROOT, "tests", "fixtures", "share");
const BROWSERS = ["/opt/microsoft/msedge/msedge", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  s.on("error", rej);
});

const MIME = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain" };
function serve(root, port) {
  const server = createServer(async (req, res) => {
    try {
      const path = normalize(join(root, decodeURIComponent(new URL(req.url, "http://x").pathname)));
      if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
      const file = path.endsWith("/") || path === root ? join(root, "index.html") : path;
      const body = await readFile(file); // read BEFORE writeHead — a 404 after 200-headers kills the server
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/* Minimal single-page CDP client: id-routed request/reply over the page target's WS. */
class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method) this.events.push(m.method);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  /** Evaluate an async expression in the page; throws on page-side exceptions. */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

async function main() {
  if (!existsSync(join(NANOODLE_ROOT, "index.html"))) {
    console.error(`no nanoodle checkout at ${NANOODLE_ROOT} — set NANOODLE_ROOT`); process.exit(1);
  }
  const browser = BROWSERS.find((b) => existsSync(b));
  if (!browser) { console.error("no chromium/edge binary found: " + BROWSERS.join(", ")); process.exit(1); }

  const httpPort = await freePort(), dbgPort = await freePort();
  const server = await serve(NANOODLE_ROOT, httpPort);
  const profile = await mkdtemp(join(tmpdir(), "noodle-fixtures-"));
  const proc = spawn(browser, [
    "--headless=new", `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank",
  ], { stdio: "ignore" });

  try {
    // wait for the debugger endpoint, then find the page target
    let targets = null;
    for (let i = 0; i < 100 && !targets; i++) {
      await sleep(150);
      try { targets = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json(); } catch {}
    }
    const target = targets?.find((t) => t.type === "page");
    if (!target) throw new Error("browser page target never appeared");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP socket failed")); });
    const page = new Page(ws);
    await page.send("Page.enable");
    await page.send("Page.navigate", { url: `http://127.0.0.1:${httpPort}/index.html` });
    // wait for the editor's share encoder to be defined (boot is idempotent about
    // overlays; evals during the cross-document navigation itself reject — retry)
    // (checked twice with a settle between: the sw.js registration can reload the
    // page right after first load, briefly landing evals on a half-parsed document)
    const READY = "typeof buildShareUrl === 'function' && typeof packShareFit === 'function' && typeof applyGraphData === 'function'";
    for (const pass of [1, 2]) {
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        await sleep(150);
        ready = await page.eval(READY).catch(() => false);
      }
      if (!ready) throw new Error("editor never became ready — buildShareUrl/packShareFit/applyGraphData undefined");
      if (pass === 1) await sleep(2500);
    }

    const starter = JSON.parse(await readFile(join(PKG_ROOT, "templates", "starter-graph.json"), "utf8"));
    const unicode = structuredClone(starter);
    for (const n of unicode.nodes) if (n.type === "text") n.fields = { ...n.fields, text: "ラーメン🍜と雨の夜 — nano-céntrico" };

    const fixtures = [];
    const add = (name, url, graph, extra = {}) => fixtures.push({ name, url, graph, ...extra });

    for (const [name, graphData] of [["g-starter", starter], ["g-unicode", unicode]]) {
      // the editor's real 🔗 Share path: applyGraphData → buildShareUrl. The expected
      // graph comes from decoding that URL with the editor's OWN loadFromHash
      // primitives (gunzip + b64urlToBytes) — never from a second shareableGraph()
      // call, which can differ once rendering fills in measured node sizes.
      const r = await page.eval(`(async () => {
        applyGraphData(${JSON.stringify(graphData)});
        const url = await buildShareUrl();
        return { url, expected: JSON.parse(await gunzip(b64urlToBytes(url.slice(url.indexOf("#g=") + 3)))) };
      })()`);
      add(name, r.url, r.expected);
    }

    // #j= — the editor's no-CompressionStream fallback line, verbatim from buildShareUrl
    {
      const r = await page.eval(`(async () => {
        applyGraphData(${JSON.stringify(starter)});
        const g = JSON.parse(JSON.stringify(shareableGraph())); // by-value snapshot: the live graph keeps mutating (measured sizes) across awaits
        return { url: location.origin + "/index.html#j=" + bytesToB64url(new TextEncoder().encode(JSON.stringify(g))), expected: g };
      })()`);
      add("j-starter", r.url, r.expected);
    }

    // #a= via the editor's real app packer (packShareFit), customized (files ride) and files-less
    {
      const r = await page.eval(`(async () => {
        applyGraphData(${JSON.stringify(starter)});
        const g = JSON.parse(JSON.stringify(shareableGraph())); // by-value snapshot: the live graph keeps mutating (measured sizes) across awaits
        const withFiles = await packShareFit({ v:1, graph:g, files:{ "index.html":"<!doctype html><title>t</title>", "app.css":"body{margin:0}" } }, [], "https://nanoodle.com/play.html", null);
        const filesLess = await packShareFit({ v:1, graph:g, name:"Fixture app", lang:"ja" }, [], "https://nanoodle.com/play.html", null);
        return { withFiles: withFiles.url, filesLess: filesLess.url, expected: g };
      })()`);
      add("a-files", r.withFiles, r.expected, { app: { hasFiles: true } });
      add("a-filesless", r.filesLess, r.expected, { app: { name: "Fixture app", lang: "ja", hasFiles: false } });
    }

    // #a=u — the editor's uncompressed fallback line, verbatim from packShareFit's pack()
    {
      const r = await page.eval(`(async () => {
        applyGraphData(${JSON.stringify(starter)});
        const g = JSON.parse(JSON.stringify(shareableGraph())); // by-value snapshot: the live graph keeps mutating (measured sizes) across awaits
        const json = JSON.stringify({ v:1, graph:g, name:"Fixture app" });
        return { url: "https://nanoodle.com/play.html#a=u" + bytesToB64url(new TextEncoder().encode(json)), expected: g };
      })()`);
      add("a-uncompressed", r.url, r.expected, { app: { name: "Fixture app", hasFiles: false } });
    }

    await rm(OUT_DIR, { recursive: true, force: true });
    await mkdir(OUT_DIR, { recursive: true });
    for (const f of fixtures) {
      await writeFile(join(OUT_DIR, f.name + ".json"), JSON.stringify(f, null, 2) + "\n");
      console.log(`${f.name}: ${f.url.length} chars`);
    }
    console.log(`wrote ${fixtures.length} fixtures to ${OUT_DIR}`);
  } finally {
    proc.kill();
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
