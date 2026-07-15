#!/usr/bin/env node
/**
 * x402 example — accountless workflow run with a terminal QR.
 *
 * Mirrors `nanoodle run … --pay`: each paid NanoGPT call prints a scannable
 * nano: QR on stderr and waits for the deposit. No API key, no account.
 *
 * Usage:
 *   node examples/x402/pay-with-qr.mjs [graph.json|share-url] [prompt]
 *
 * Defaults: ./noodle-graph.json (run `npx nanoodle init` first if missing).
 *
 * Import: this file loads the local package source so it works in a git checkout.
 * After `npm install nanoodle`, switch the import to:
 *   import { Workflow, qrTerminal, MediaRef, extForMime } from "nanoodle";
 * (extForMime is internal — or hard-code the extension from value.mime.)
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { Workflow, qrTerminal } from "../../src/index.mjs";
import { MediaRef, extForMime } from "../../src/media.mjs";

const graph = process.argv[2] || "noodle-graph.json";
const prompt = process.argv[3]; // optional — omit to use the graph's default Text

async function main() {
  const payment = async (inv) => {
    const mins = inv.expiresAt
      ? Math.max(1, Math.round((inv.expiresAt - Date.now()) / 60000))
      : null;
    console.error(
      `\n⚡ payment required: ${inv.amount || inv.amountRaw + " raw"}` +
        (inv.amountUsd != null ? ` (~$${inv.amountUsd})` : ""),
    );
    console.error(qrTerminal(inv.uri));
    console.error("scan with your Nano wallet (dark terminals scan best), or send to:");
    console.error("  " + inv.payTo);
    console.error("  " + inv.uri);
    if (inv.explorerUrl) console.error("  explorer: " + inv.explorerUrl);
    console.error(
      `waiting for the deposit…${mins ? ` (invoice expires in ~${mins} min,` : " ("}Ctrl-C aborts)\n`,
    );
    // Engine polls completeUrl until the deposit is seen — nothing else to do here.
  };

  // apiKey: null is required — undefined would re-inject $NANOGPT_API_KEY and charge an account.
  const wf = await Workflow.load(graph, { apiKey: null, payment });

  const inputs = {};
  if (prompt != null) inputs.Text = prompt;

  const outDir = "noodle-out";
  let dirMade = false;

  const result = await wf.run(inputs, {
    onProgress: (evt) => {
      if (evt.type === "node-start") console.error(`▶ ${evt.name} (${evt.nodeId})`);
      if (evt.type === "node-done") console.error(`✓ ${evt.name} — ${evt.ms ?? "?"} ms`);
      if (evt.type === "node-error") console.error(`✗ ${evt.name} — ${evt.error}`);
    },
  });

  for (const o of wf.outputs) {
    const v = result.get(o.key);
    if (v instanceof MediaRef) {
      if (!dirMade) {
        await mkdir(outDir, { recursive: true });
        dirMade = true;
      }
      const safe = o.key.replace(/[^\w.-]+/g, "_");
      const path = join(outDir, safe + "." + extForMime(v.mime || ""));
      await v.save(path);
      console.log(`${o.key}: ${path}`);
    } else {
      console.log(`${o.key}:\n${v}`);
    }
  }
  const approx = result.costExact ? "" : "≥ ";
  console.error(
    `cost: ${approx}$${result.costUsd}` +
      (result.remainingBalance != null ? ` · balance: $${result.remainingBalance}` : ""),
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
