#!/usr/bin/env node
/**
 * OPT-IN live smoke test against the real NanoGPT API. SPENDS REAL MONEY (a fraction of a cent
 * for the LLM step; a few cents more with --image). Never run by CI.
 *
 *   NANOGPT_API_KEY=... node scripts/live-spot-check.mjs
 *   node scripts/live-spot-check.mjs --env-file ../nanoodle/.env
 *   node scripts/live-spot-check.mjs --image        # additionally runs the starter graph's image step
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { Workflow } from "../src/index.mjs";

const argv = process.argv.slice(2);
const withImage = argv.includes("--image");
const envIdx = argv.indexOf("--env-file");

let apiKey = process.env.NANOGPT_API_KEY;
if (envIdx >= 0) {
  const envText = await readFile(argv[envIdx + 1], "utf8");
  const m = envText.match(/^NANOGPT_API_KEY\s*=\s*"?([^"\n]+)"?/m);
  if (m) apiKey = m[1].trim();
}
if (!apiKey) {
  console.error("set NANOGPT_API_KEY (or pass --env-file path) — this script makes LIVE paid calls");
  process.exit(1);
}

const onProgress = (e) => {
  if (e.type === "node-start") console.log(`▶ ${e.name}`);
  if (e.type === "node-done") console.log(`✔ ${e.name} ${e.ms}ms${e.costUsd != null ? ` $${e.costUsd}` : ""}`);
};

// cheap text→llm probe: zai-org/glm-5.2, maxTokens 60
const llmOnly = Workflow.fromJSON({
  nodes: [
    { id: "n1", type: "text", fields: { text: "a cozy ramen shop on a rainy night" } },
    { id: "n2", type: "llm", fields: { model: "zai-org/glm-5.2", maxTokens: "60", system: "Reply with one short vivid sentence." } },
  ],
  links: [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
}, { apiKey });

console.log("live spot-check: llm (zai-org/glm-5.2, maxTokens 60)…");
const r1 = await llmOnly.run({}, { onProgress });
console.log("text:", String(r1.get("LLM")));
console.log(`cost: ${r1.costExact ? "" : "≥ "}$${r1.costUsd}${r1.remainingBalance != null ? ` · balance $${r1.remainingBalance}` : ""}`);

if (withImage) {
  console.log("\nlive spot-check: full starter graph (llm → image)…");
  const starter = await Workflow.load(fileURLToPath(new URL("../tests/fixtures/starter-graph.json", import.meta.url)), { apiKey });
  const r2 = await starter.run({}, { settings: { "n2.maxTokens": 60 }, onProgress });
  const img = r2.get("Image");
  const path = await img.save("live-spot-check-image." + (img.mime === "image/jpeg" ? "jpg" : "png"));
  console.log("image saved:", path);
  console.log(`cost: ${r2.costExact ? "" : "≥ "}$${r2.costUsd}${r2.remainingBalance != null ? ` · balance $${r2.remainingBalance}` : ""}`);
}
