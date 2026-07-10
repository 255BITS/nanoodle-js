# nanoodle

Run [nanoodle](https://nanoodle.io) AI workflows server-side. Build a workflow visually in the
nanoodle editor, hit 💾 to download `noodle-graph.json`, and re-execute it anywhere Node runs —
against the same [NanoGPT](https://nano-gpt.com) API the app uses.

- **Zero runtime dependencies** (Node >= 20, built-in `fetch`)
- Same execution semantics as the app: topological order, concurrent lanes, wired-field overrides
- Text, image, video (submit + poll), audio (sync + async poll), vision, transcription
- Cost tracking per node and per run

## Quickstart

```bash
npm install nanoodle
export NANOGPT_API_KEY=...   # nano-gpt.com API key (or OAuth access token)
```

```js
import { Workflow } from "nanoodle";

const wf = await Workflow.load("noodle-graph.json");
const result = await wf.run({ Text: "a cozy ramen shop on a rainy night" });

console.log(String(result.get("Image")));   // media outputs are MediaRef (url + bytes()/save())
await result.get("Image").save("ramen.png");
console.log(result.costUsd, result.remainingBalance);
```

With the starter graph from the app (text → LLM prompt-writer → image), that's the whole program.

### Discover a workflow's interface

```js
wf.inputs    // [{ key: "Text", nodeId: "n1", field: "text", kind: "textarea", optional: false, def: "..." }]
wf.outputs   // [{ key: "Image", nodeId: "n3", type: "image", ports: [{ name: "image", type: "image" }] }]
wf.settings  // [{ key: "n3.model", kind: "model", def: "nano-banana-2-lite" }, ...]
```

Input keys resolve flexibly (case-insensitive): the node's custom name, `nodeId.field`
(`"n2.system"`), a bare node id, or the input's label. A workflow with exactly one required
input also accepts a bare value: `wf.run("hello")`.

### Media inputs

```js
import { mediaFromFile } from "nanoodle";

await wf.run({ Image: await mediaFromFile("photo.jpg") });     // local file
await wf.run({ Image: "https://example.com/photo.jpg" });      // hosted URL
await wf.run({ Image: bytesUint8Array });                      // raw bytes (MIME sniffed)
```

Media is sent inline as base64 (NanoGPT has no upload endpoint); files over ~4.4 MB are
refused locally with a clear error before any paid call.

### Settings, progress, errors

```js
const result = await wf.run(
  { Text: "sunset harbor" },
  {
    settings: { "n3.model": "flux-dev", "n3.size": "1024x1024" },
    timeoutMs: 300000,
    onProgress: (e) => console.error(e.type, e.name ?? "", e.status ?? ""),
  },
);
```

`run()` rejects with `RunError` when an output (sink) node failed — `err.result` still carries
the partial results, per-node statuses, and cost so far. Failures in lanes no output depends on
only surface in `result.errors`. Unknown/unsupported node types, missing required inputs, bad
keys, and a missing API key all fail **before** anything is spent.

### CLI

```bash
npx nanoodle inspect graph.json
npx nanoodle run graph.json --input Text="a cozy ramen shop" --set n3.size=1k --out ./out
npx nanoodle run graph.json --input n2.system=@style.txt --json
```

## Supported nodes

| runs | node types |
|---|---|
| local | text, upload (image/audio/video), choice, join, comment |
| NanoGPT | llm (incl. vision + audio input), image, draw, edit, inpaint*, vision, tvideo, ivideo, vedit, lipsync, music, remix, tts, transcribe |
| **not supported** (browser-only media processing) | resize, vframes, combine, soundtrack, trim, extractaudio |

Workflows containing unsupported node types load with a warning and fail fast at `run()` with
`UnsupportedNodeError` — before any network call.

\* inpaint caveat: the browser app composites the mask onto black at the source's pixel size;
this library passes your mask through verbatim, so supply a black/white mask matching the
source dimensions.

## Cost

NanoGPT bills per generation and reports the price on each response; `result.costUsd` totals it
and `result.costExact` turns false when any call omitted a price (the total is then a floor).
`result.remainingBalance` is the freshest balance the API reported. A price of 0 means
known-free (subscription-included), not unknown.

## Testing

Tests run fully offline against a mock NanoGPT server (`tests/harness/`):

```bash
npm test
```

An opt-in live probe (spends a fraction of a cent) exists for hand-verification:
`node scripts/live-spot-check.mjs` (add `--image` to also run the starter graph's image step).

## License

MIT — see [LICENSE](LICENSE). Not affiliated with NanoGPT. Build workflows at
[nanoodle.io](https://nanoodle.io).
