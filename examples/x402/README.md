# x402 usage examples — pay per run in Nano (no account)

NanoGPT supports **x402** accountless payments: call the API with no key, get an
HTTP 402 invoice, settle it in **Nano (XNO)** — instant, feeless — and the call
completes. nanoodle wires that up end to end.

The library **never holds funds or keys**. You supply a `payment` callback; the
send happens in *your* wallet/signer (or a human scanning a QR). Passing a seed
or private key throws.

## How the flow works

```
1. Request with x-x402: true  (no Authorization)
2. API answers HTTP 402 with payment options (Nano among them)
3. nanoodle parses the Nano invoice → calls your payment(invoice)
4. You send amountRaw raw units of XNO to payTo (or show invoice.uri)
5. nanoodle polls the complete URL until the deposit is seen
6. Result is returned (replayed body, or re-POST with x-x402-payment-id)
```

Each API call pays **at most once**. Graphs with several paid nodes produce one
small invoice per node. Chat and image nodes are live-verified; async
video/audio job polling under accountless mode is untested upstream.

## Prerequisites

- Node ≥ 20
- A Nano wallet with a tiny amount of XNO (cents)
- This package installed (`npm install nanoodle`) or a checkout of this repo

No NanoGPT account. No API key.

## 1. CLI — scan a QR and wait

Fastest path. `--pay` ignores any configured key, prints a terminal QR +
`nano:` URI on stderr for each paid call, and resumes when the deposit lands:

```bash
# scaffold the starter graph (text → LLM → image) if you don't have one
npx nanoodle init

npx nanoodle run noodle-graph.json \
  --input Text="a cozy ramen shop on a rainy night" \
  --pay --out ./noodle-out

# or any share link
npx nanoodle run "https://nanoodle.com/#g=..." --input Text="hello" --pay
```

## 2. Library — human pays (QR in the terminal)

Same behavior as the CLI, as a script:

```bash
# from this repo (uses local src/)
node examples/x402/pay-with-qr.mjs noodle-graph.json "a cozy ramen shop on a rainy night"

# after npm install nanoodle, point the import at "nanoodle" (see script header)
```

See [`pay-with-qr.mjs`](./pay-with-qr.mjs).

## 3. Library — programmatic wallet / signer

Your `payment` callback receives a frozen invoice and must send XNO itself.
This example logs the invoice and shows where to plug a signer — it does **not**
broadcast a transaction:

```bash
node examples/x402/pay-with-wallet.mjs noodle-graph.json "hello from x402"
```

See [`pay-with-wallet.mjs`](./pay-with-wallet.mjs).

## 4. Minimal chat (no graph file)

One paid chat completion via `NanoClient` — useful for probing the wire format:

```bash
node examples/x402/pay-chat.mjs "say hi in five words"
```

See [`pay-chat.mjs`](./pay-chat.mjs).

## Invoice shape

The object your `payment` callback receives (field-identical in nanoodle-py):

| Field | Meaning |
|---|---|
| `scheme` | always `"nano"` |
| `paymentId` | e.g. `pay_…` |
| `payTo` | `nano_…` destination address |
| `amountRaw` | integer raw units as a **string** (1 XNO = 10³⁰ raw) |
| `amount` | human string, e.g. `"0.00018406 XNO"` |
| `amountUsd` | USD estimate (number) or `null` |
| `uri` | ready-to-scan `nano:ADDRESS?amount=RAW` |
| `expiresAt` | epoch **ms** (or `null`) |
| `statusUrl` | poll deposit status |
| `completeUrl` | settle / fetch the stored result |
| `explorerUrl` | block explorer link when present |
| `description` | optional |
| `requestHash` | optional request binding |

Helpers: `parseNanoInvoice(body, baseUrl)`, `qrTerminal(uri)`, `qrModules(uri)`.

## Critical: stay keyless

When using `payment`, pass **`apiKey: null`** (not `undefined`). `undefined`
lets `NANOGPT_API_KEY` from the environment re-inject a key, which **disables**
the x402 settle path and charges the account instead. The CLI `--pay` flag does
this for you.

```js
const wf = await Workflow.load(graph, {
  apiKey: null,            // ← required for accountless
  payment: async (inv) => { /* send or display */ },
});
```

## Safety

- Never put a seed or private key in `payment` — it must be a function.
- Confirm `amount` / `amountUsd` before sending in automated wallets.
- Respect `expiresAt`; expired invoices fail cleanly (`x402-expired`).
- A second 402 after a successful settle is an error, never a second send.

## Sibling package

Same examples for Python: [nanoodle-py/examples/x402](https://github.com/nanoodlecom/nanoodle-py/tree/main/examples/x402).
