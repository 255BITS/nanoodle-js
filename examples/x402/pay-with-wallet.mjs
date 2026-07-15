#!/usr/bin/env node
/**
 * x402 example — accountless run with a programmatic payment callback.
 *
 * The callback receives a frozen invoice. Plug your own Nano signer in the
 * marked section. This script does NOT broadcast a transaction — it prints the
 * fields you would send, then returns so the engine can wait for a deposit
 * (which will time out unless you send from a real wallet).
 *
 * Usage:
 *   node examples/x402/pay-with-wallet.mjs [graph.json|share-url] [prompt]
 *
 * Import: local checkout uses ../../src; with the published package use "nanoodle".
 */
import process from "node:process";
import { Workflow } from "../../src/index.mjs";

const graph = process.argv[2] || "noodle-graph.json";
const prompt = process.argv[3] || "hello from x402 wallet example";

/**
 * @param {Readonly<{
 *   scheme: string,
 *   paymentId: string,
 *   payTo: string,
 *   amountRaw: string,
 *   amount: string|null,
 *   amountUsd: number|null,
 *   uri: string,
 *   expiresAt: number|null,
 *   statusUrl: string|null,
 *   completeUrl: string|null,
 *   explorerUrl: string|null,
 *   description: string|null,
 *   requestHash: string|null,
 * }>} inv
 */
async function payWithMyWallet(inv) {
  // ── 1. Inspect before sending ───────────────────────────────────────────
  console.error("invoice received:");
  console.error(JSON.stringify({
    paymentId: inv.paymentId,
    payTo: inv.payTo,
    amountRaw: inv.amountRaw,   // integer string; 1 XNO = 10^30 raw
    amount: inv.amount,
    amountUsd: inv.amountUsd,
    uri: inv.uri,               // nano:ADDRESS?amount=RAW
    expiresAt: inv.expiresAt,   // epoch ms
    explorerUrl: inv.explorerUrl,
  }, null, 2));

  if (inv.expiresAt && Date.now() > inv.expiresAt) {
    throw new Error("invoice already expired — refuse to send");
  }

  // ── 2. YOUR signer does the send (never pass a seed into nanoodle) ──────
  //
  //   await myWallet.send({
  //     to: inv.payTo,
  //     amountRaw: inv.amountRaw,   // keep as string — raw is a 30+ digit integer
  //   });
  //
  // Or hand the URI to any Nano wallet that understands nano: deep links:
  //   openExternal(inv.uri);
  //
  // Until a real deposit lands, the engine will poll completeUrl and
  // eventually throw x402-expired. That is expected for this demo stub.

  console.error(
    "\n(stub) no send performed — open a real wallet and pay:\n" +
      `  ${inv.uri}\n` +
      "then wait; nanoodle will resume when the deposit is detected.\n",
  );
}

async function main() {
  const wf = await Workflow.load(graph, {
    apiKey: null, // must be null for accountless (not undefined)
    payment: payWithMyWallet,
  });

  const result = await wf.run({ Text: prompt }, {
    onProgress: (evt) => {
      if (evt.type === "node-start") console.error(`▶ ${evt.name}`);
      if (evt.type === "node-done") console.error(`✓ ${evt.name}`);
    },
  });

  for (const o of wf.outputs) {
    const v = result.get(o.key);
    console.log(`${o.key}:`, typeof v?.save === "function" ? `(media ${v.mime || "binary"})` : v);
  }
  console.error(`cost: $${result.costUsd.toFixed(4)}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
