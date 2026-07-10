import test from "node:test";
import assert from "node:assert/strict";
import { Workflow, RunError } from "../src/index.mjs";
import { startMockServer, mockOpts } from "./harness/mock-server.mjs";

const videoWf = (srv) => Workflow.fromJSON({
  nodes: [{ id: "n1", type: "tvideo", fields: { model: "veo-3.1-fast", prompt: "a fox" } }],
  links: [],
}, mockOpts(srv));

const musicWf = (srv) => Workflow.fromJSON({
  nodes: [{ id: "n1", type: "music", fields: { model: "suno-v5", prompt: "lofi" } }],
  links: [],
}, mockOpts(srv));

test("video poll: transient GET failures (non-JSON body) are silently skipped until success", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "v1", cost: 0.2 } });
  srv.script("GET /api/video/status", [
    { status: 502, body: "<html>bad gateway</html>" }, // not JSON → keep polling
    { status: 500, body: "boom" },
    { json: { status: "COMPLETED", output: { url: "https://cdn.example/ok.mp4" } } },
  ]);

  const result = await videoWf(srv).run({});
  assert.equal(srv.of("GET /api/video/status").length, 3);
  assert.equal(result.get("Text→Video").url, "https://cdn.example/ok.mp4");
});

test("video poll: url from out.video[0].url when output.video is an ARRAY", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "v2", cost: 0.2 } });
  srv.script("GET /api/video/status", { json: { status: "COMPLETED", output: { video: [{ url: "https://cdn.example/arr.mp4" }] } } });

  const result = await videoWf(srv).run({});
  assert.equal(result.get("Text→Video").url, "https://cdn.example/arr.mp4");
});

test("video poll: COMPLETED without any url → 'completed but no video url'", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "v3", cost: 0.2 } });
  srv.script("GET /api/video/status", { json: { status: "COMPLETED", output: {} } });

  await assert.rejects(videoWf(srv).run({}), /completed but no video url/);
});

test("video poll: FAILED with no error detail falls back to the status word", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "v4", cost: 0.2 } });
  srv.script("GET /api/video/status", { json: { status: "FAILED" } });

  await assert.rejects(videoWf(srv).run({}), /video failed: FAILED/);
});

test("video submit without runId or id → 'no runId returned'", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { accepted: true } });

  await assert.rejects(videoWf(srv).run({}), /no runId returned/);
});

test("audio poll: transient GET failure skipped, then completed via s.data.url variant", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { runId: "a1", cost: 0.1 } });
  srv.script("GET /api/tts/status", [
    { status: 503, body: "unavailable" },
    { json: { status: "processing" } },
    { json: { status: "succeeded", data: { url: "https://cdn.example/deep.mp3" } } },
  ]);

  const result = await musicWf(srv).run({});
  assert.equal(srv.of("GET /api/tts/status").length, 3);
  assert.equal(result.get("Music").url, "https://cdn.example/deep.mp3");
});

test("audio poll: times out after timeouts.audio while the server stays pending", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { runId: "a2", cost: 0.1 } });
  srv.script("GET /api/tts/status", { json: { status: "pending" } });

  const wf = musicWf(srv);
  wf.client.timeouts.audio = 40; // a handful of ~5ms polls then give up
  await assert.rejects(wf.run({}), /audio timed out/);
  assert.ok(srv.of("GET /api/tts/status").length >= 2); // it did keep polling until the deadline
});

test("audio poll: completed with no url anywhere → 'completed but no audio url'", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { runId: "a3", cost: 0.1 } });
  srv.script("GET /api/tts/status", { json: { status: "completed" } });

  await assert.rejects(musicWf(srv).run({}), /completed but no audio url/);
});

test("audio JSON response with neither url nor runId → 'no audio url in response'", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { ok: true, cost: 0.1 } });

  await assert.rejects(musicWf(srv).run({}), /no audio url in response/);
  assert.equal(srv.of("GET /api/tts/status").length, 0); // no runId → nothing to poll
});

test("audio poll query stays minimal when submit JSON lacks the refund params", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { id: "a4" } }); // j.id fallback, no cost/paymentSource/isApiRequest
  srv.script("GET /api/tts/status", { json: { status: "completed", url: "https://cdn.example/min.mp3" } });

  const result = await musicWf(srv).run({});
  assert.deepEqual(srv.of("GET /api/tts/status")[0].query, { runId: "a4", model: "suno-v5" });
  assert.equal(result.get("Music").url, "https://cdn.example/min.mp3");
});

test("audio poll: onProgress poll events carry lowercase status + queuePosition", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { runId: "a5", cost: 0.1 } });
  srv.script("GET /api/tts/status", [
    { json: { status: "pending", queuePosition: 3 } },
    { json: { status: "completed", audioUrl: "https://cdn.example/q.mp3" } },
  ]);

  const polls = [];
  await musicWf(srv).run({}, { onProgress: (e) => { if (e.type === "poll") polls.push(e); } });
  assert.equal(polls[0].status, "pending");
  assert.equal(polls[0].queuePosition, 3);
  assert.equal(polls[0].nodeId, "n1");
  assert.equal(polls[1].status, "completed");
});

test("external AbortSignal cancels an in-flight poll loop and fails the run", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "v5", cost: 0.2 } });
  srv.script("GET /api/video/status", { json: { status: "PENDING" } });

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 40);
  await assert.rejects(videoWf(srv).run({}, { signal: ac.signal }), (e) => {
    assert.ok(e instanceof RunError);
    assert.match(e.result.nodes.n1.error, /abort/i);
    return true;
  });
});
