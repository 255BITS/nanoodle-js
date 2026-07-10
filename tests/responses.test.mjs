import test from "node:test";
import assert from "node:assert/strict";
import { Workflow, NanoClient } from "../src/index.mjs";
import { startMockServer, mockOpts, WAV_B64 } from "./harness/mock-server.mjs";

const llmWf = (srv, fields = {}) => Workflow.fromJSON({
  nodes: [{ id: "n1", type: "llm", fields: { model: "m", prompt: "hi", ...fields } }],
  links: [],
}, mockOpts(srv));

test("chat parse: content null → 'no text in response'; empty string too", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: null } }] } });
  await assert.rejects(llmWf(srv).run({}), /no text in response/);

  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: "" } }] } });
  await assert.rejects(llmWf(srv).run({}), /no text in response/);
});

test("chat parse: array content joins its .text parts", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", {
    json: { choices: [{ message: { content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }, { type: "other" }] } }], cost: 0.001 },
  });
  const result = await llmWf(srv).run({});
  assert.equal(result.get("LLM"), "Hello world");
});

test("llm showThinking: message.reasoning rides in a thinking fence before the answer", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", {
    json: { choices: [{ message: { content: "42", reasoning: "six times seven" } }], cost: 0.001 },
  });
  const result = await llmWf(srv, { showThinking: "true" }).run({});
  assert.equal(result.get("LLM"), "```thinking\nsix times seven\n```\n\n42");

  // showThinking off → the trace is dropped
  srv.script("POST /api/v1/chat/completions", {
    json: { choices: [{ message: { content: "42", reasoning: "six times seven" } }], cost: 0.001 },
  });
  const plain = await llmWf(srv).run({});
  assert.equal(plain.get("LLM"), "42");
});

test("image parse: empty data list → 'no image in response'", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", { json: { data: [], cost: 0.02 } });
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "image", fields: { model: "flux", prompt: "x" } }],
    links: [],
  }, mockOpts(srv));
  await assert.rejects(wf.run({}), /no image in response/);
});

test("draw parse: text-only reply and empty reply get distinct errors", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const drawWf = () => Workflow.fromJSON({
    nodes: [{ id: "n1", type: "draw", fields: { model: "gemini-3-pro-image-preview", prompt: "a moon" } }],
    links: [],
  }, mockOpts(srv));

  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: "I cannot draw that." } }] } });
  await assert.rejects(drawWf().run({}), /replied with text, not an image/);

  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: null } }] } });
  await assert.rejects(drawWf().run({}), /no image in response/);
});

test("draw parse: image entries as plain strings and {url} objects both work; reasoning fenced by default", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", {
    json: {
      choices: [{
        message: {
          content: "done",
          reasoning: "sketching…",
          images: ["data:image/png;base64,S1", { url: "https://cdn.example/x.png" }, null],
        },
      }],
      cost: 0.01,
    },
  });
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "draw", fields: { model: "gemini-3-pro-image-preview", prompt: "a moon" } }],
    links: [],
  }, mockOpts(srv));
  const result = await wf.run({});
  assert.deepEqual(result.nodes.n1.out.images, ["data:image/png;base64,S1", "https://cdn.example/x.png"]);
  // draw's showThinking defaults ON (SETTING_SPECS def true) → the trace is fenced onto the text port
  assert.equal(result.nodes.n1.out.text, "```thinking\nsketching…\n```\n\ndone");
});

test("transcribe parse priority: transcription → text → data.transcription/text", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const wf = () => Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "aupload", fields: { audio: "data:audio/wav;base64," + WAV_B64 } },
      { id: "n2", type: "transcribe", fields: { model: "whisper-large-v3" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "audio" }, to: { node: "n2", port: "audio" } }],
  }, mockOpts(srv));

  srv.script("POST /api/v1/audio/transcriptions", { json: { transcription: "first", text: "shadowed", cost: 0.001 } });
  assert.equal((await wf().run({})).get("Transcribe"), "first");

  srv.script("POST /api/v1/audio/transcriptions", { json: { data: { text: "nested" }, cost: 0.001 } });
  assert.equal((await wf().run({})).get("Transcribe"), "nested");

  srv.script("POST /api/v1/audio/transcriptions", { json: { language: "en" } });
  await assert.rejects(wf().run({}), /no transcription in response/);
});

test("binary audio with a concrete content-type keeps it (no format pin)", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const wavBytes = Buffer.from(WAV_B64, "base64");
  srv.script("POST /api/v1/audio/speech", {
    headers: { "content-type": "audio/wav", "x-cost": "0.004" },
    body: wavBytes,
  });
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "tts", fields: { model: "kokoro-82m", prompt: "hello" } }],
    links: [],
  }, mockOpts(srv));
  const result = await wf.run({});
  const audio = result.get("Speech");
  assert.equal(audio.mime, "audio/wav"); // server's own type wins over the mp3 default pin
  assert.deepEqual(Buffer.from(await audio.bytes()), wavBytes);
});

test("transcribe with an https source: media download carries NO auth headers, then multipart upload", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const wavBytes = Buffer.from(WAV_B64, "base64");
  srv.script("GET /media/clip.mp3", { headers: { "content-type": "audio/mpeg" }, body: wavBytes });
  srv.script("POST /api/v1/audio/transcriptions", { json: { text: "spoken words", cost: 0.001 } });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "aupload", fields: { audio: srv.url + "/media/clip.mp3" } },
      { id: "n2", type: "transcribe", fields: { model: "whisper-large-v3" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "audio" }, to: { node: "n2", port: "audio" } }],
  }, mockOpts(srv));
  const result = await wf.run({});

  const dl = srv.of("GET /media/clip.mp3")[0];
  assert.equal(dl.headers.authorization, undefined); // never leak the key to a media CDN
  assert.equal(dl.headers["x-api-key"], undefined);
  const up = srv.of("POST /api/v1/audio/transcriptions")[0];
  assert.equal(up.headers.authorization, "Bearer test-key"); // API upload IS authed
  assert.match(up.raw.toString("latin1"), /name="file"; filename="audio\.mpeg"/); // ext from the download's content-type
  assert.equal(result.get("Transcribe"), "spoken words");
});

test("transcribe local guard: clips over ~3.5MB refused before any request", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const bigB64 = Buffer.alloc(3.7 * 1024 * 1024).toString("base64");
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "aupload", fields: { audio: "data:audio/wav;base64," + bigB64 } },
      { id: "n2", type: "transcribe", fields: { model: "whisper-large-v3" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "audio" }, to: { node: "n2", port: "audio" } }],
  }, mockOpts(srv));
  await assert.rejects(wf.run({}), /too big to transcribe directly/);
  assert.equal(srv.requests.length, 0);
});

test("checkBalance helper: POST {} with both auth headers → usd_balance", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/check-balance", { json: { usd_balance: 12.34 } });

  const client = new NanoClient({ apiKey: "test-key", baseUrl: srv.url });
  const j = await client.checkBalance();
  assert.equal(j.usd_balance, 12.34);
  const req = srv.requests[0];
  assert.deepEqual(req.json, {});
  assert.equal(req.headers.authorization, "Bearer test-key");
  assert.equal(req.headers["x-api-key"], "test-key");
});
