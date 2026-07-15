#!/usr/bin/env node
/**
 * x402 example — single paid chat completion, no workflow graph.
 *
 * Useful for probing the accountless wire format (one invoice → one reply).
 *
 * Usage:
 *   node examples/x402/pay-chat.mjs ["your prompt"]
 */
import process from "node:process";
import { NanoClient, qrTerminal } from "../../src/index.mjs";

const prompt = process.argv[2] || "Say hello in exactly five words.";

async function main() {
  let costUsd = null;
  const client = new NanoClient({
    apiKey: null,
    payment: async (inv) => {
      console.error(
        `\n⚡ payment required: ${inv.amount || inv.amountRaw + " raw"}` +
          (inv.amountUsd != null ? ` (~$${inv.amountUsd})` : ""),
      );
      console.error(qrTerminal(inv.uri));
      console.error("  " + inv.payTo);
      console.error("  " + inv.uri);
      console.error("waiting for the deposit… (Ctrl-C aborts)\n");
    },
  });

  // cheap, fast model for a smoke probe — override freely
  const text = await client.chat(
    [{ role: "user", content: prompt }],
    "zai-org/glm-5.2",
    { max_tokens: 60 },
    { onCost: ({ usd }) => { costUsd = usd; } },
  );

  console.log(text);
  if (costUsd != null) console.error(`cost: $${costUsd}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
