/**
 * Replace-prep Phase E hooks: the play delegation shim drives NanoClient and
 * RUNNERS directly, keeping its resume registry (PENDING_VIDEO/PENDING_AUDIO)
 * and canvas media outside the library. These lock the hook contracts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NanoClient } from "../src/client.mjs";
import { RUNNERS } from "../src/nodes.mjs";
import { startMockServer, PNG_DATA_URL } from "./harness/mock-server.mjs";

const fastPolls = { pollIntervals: { video: 1, audio: 1 }, timeouts: { video: 3000, audio: 3000 } };

test("video: onRunId fires on fresh submit; resume skips the submit (and its charge)", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const done = { json: { data: { status: "COMPLETED", output: { video: { url: "https://cdn.example/v.mp4" } } } } };
  srv.script("POST /api/generate-video", { json: { runId: "vid_9", cost: 0.2 } });
  srv.script("GET /api/video/status", [done, done]);

  const client = new NanoClient({ apiKey: "k", baseUrl: srv.url, ...fastPolls });
  let seen = null, cost = 0;
  const url = await client.video("m", "waves", {}, undefined,
    { onRunId: (id) => { seen = id; }, onCost: (c) => { cost += c.usd || 0; } });
  assert.equal(url, "https://cdn.example/v.mp4");
  assert.equal(seen, "vid_9");
  assert.equal(cost, 0.2);

  // resume: no second POST, no second charge, straight to polling the given runId
  const submits = srv.of("POST /api/generate-video").length;
  let cost2 = 0, runIdCb = 0;
  const url2 = await client.video("m", "waves", {}, undefined,
    { resume: "vid_9", onRunId: () => runIdCb++, onCost: (c) => { cost2 += c.usd || 0; } });
  assert.equal(url2, "https://cdn.example/v.mp4");
  assert.equal(srv.of("POST /api/generate-video").length, submits, "no re-submit");
  assert.equal(cost2, 0, "no second charge");
  assert.equal(runIdCb, 0, "onRunId is fresh-submit-only");
});

test("audio: onRunId hands over the poll job; resume polls it without a re-submit", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { runId: "aud_7", cost: 0.05, paymentSource: "balance", isApiRequest: false } });
  srv.script("GET /api/tts/status", [
    { json: { status: "completed", audioUrl: "https://cdn.example/a.mp3" } },
    { json: { status: "completed", audioUrl: "https://cdn.example/a.mp3" } },
  ]);

  const client = new NanoClient({ apiKey: "k", baseUrl: srv.url, ...fastPolls });
  let job = null;
  const url = await client.audio("songer", "jazz", {}, { onRunId: (j) => { job = j; } });
  assert.equal(url, "https://cdn.example/a.mp3");
  assert.equal(job.runId, "aud_7");

  const submits = srv.of("POST /api/v1/audio/speech").length;
  const url2 = await client.audio("songer", "jazz", {}, { resume: job });
  assert.equal(url2, "https://cdn.example/a.mp3");
  assert.equal(srv.of("POST /api/v1/audio/speech").length, submits, "no re-submit");
  // the poll carries the job's refund metadata, exactly like a fresh poll would
  const poll = srv.of("GET /api/tts/status").at(-1);
  assert.equal(poll.query.runId, "aud_7");
  assert.equal(poll.query.paymentSource, "balance");
});

test("inpaint: ctx.maskToSource override wins (browser canvas compositor injection)", async () => {
  let sent = null;
  const ctx = {
    image: async (args) => { sent = args; return PNG_DATA_URL; },
    maskToSource: async (mask, source) => `composited:${mask.length}x${source.length}`,
    progress() {},
    catalog: null,
  };
  const n = { id: "p1", type: "inpaint", fields: { model: "m", prompt: "hat", image: PNG_DATA_URL, mask: PNG_DATA_URL } };
  await RUNNERS.inpaint(n, {}, ctx);
  assert.equal(sent.maskDataUrl, `composited:${PNG_DATA_URL.length}x${PNG_DATA_URL.length}`);
  assert.equal(sent.imageDataUrl, PNG_DATA_URL);
});
