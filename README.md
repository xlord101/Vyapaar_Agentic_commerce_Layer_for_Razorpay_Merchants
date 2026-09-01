# Vyapaar

**An agentic commerce layer for Razorpay merchants.** It makes a merchant transactable by an AI buyer end to end, and grows the basket once the buyer arrives — with every money action bounded, gated and explained.

> Agent-readable commerce, bounded by design.

```
git clone <repo> && cd vyapaar-agent
npm install
npm run dev          # http://localhost:8787
npm test             # 34 assertions
npm run demo         # full end-to-end story in your terminal
```

No API keys required. It boots on a built-in payment simulator and a deterministic intent parser, so anyone can run the whole thing before reading a word of this README.

---

## The problem

Two things have to be true before agent-to-agent commerce is real, and today neither is.

**A merchant is not machine-readable.** An AI buyer that wants to shop a store has to scrape HTML and guess which `<div>` is the price. The merchant has no way to state the things that actually matter to a buyer: what's in stock, what isn't discountable, what ships when, and which endpoint will genuinely accept an order.

**Nobody has solved bounded autonomy.** The moment you let software spend money, three questions become urgent, and hand-waving any of them is disqualifying:

1. What is it *allowed* to spend? (bounds)
2. What stops it when it shouldn't? (gates)
3. When it spends, can you reconstruct exactly why? (audit)

Most agent-commerce demos answer "the model decides." That is not an answer. A model that computes money will eventually compute it wrong, and there is no downstream gate that catches an arithmetic hallucination before the charge clears.

Vyapaar is built on the opposite bet: **make the autonomous part narrow and the deterministic part load-bearing.**

---

## What I built

Three pieces. Two are the track's two halves; the third is the spine that stops them from being dangerous.

### 1. Make the merchant transactable (the buyer half)

A machine-readable commerce surface an AI buyer can consume without scraping anything:

| Endpoint | What it gives the agent |
|---|---|
| `/.well-known/agent-commerce.json` | Capability manifest: what exists, where it is, which payment rails, what constraints are enforced |
| `/api/v1/feed/products` | Typed product feed — paise integers, stock, ship times, attributes, discountability |
| `/llms.txt` | The same catalog as tokens, for agents that would rather read than parse |
| `/api/v1/feed/offers` | What the merchant will offer for a given cart, and *why* |
| `/api/v1/commerce/quote` | A price promise, valid 900s, with the policy verdict attached |
| `/api/v1/commerce/orders` | Checkout. Requires an `Idempotency-Key`. |

The manifest is shaped deliberately close to where ACP / AP2 / UAP are converging — discovery manifest, typed feed, server-side order then payment — because the protocol will settle and the merchant's data model shouldn't have to change when it does.

**The AI buyer** (`src/agent/`) turns a sentence into a settled order:

```
"I need 2 ergonomic mesh chairs under 20000 each, delivered within 5 days"
  → plan       parse to a typed PurchaseIntent (confidence 0.85)
  → discover   2 candidates; relaxes constraints in a defined order if none match
  → evaluate   picks by match score, records what it rejected
  → offer      weighs merchant offers, rejects any that would breach its mandate
  → gate       ALLOW / REQUIRE_APPROVAL / DENY
  → pay        server-side Razorpay order
```

When it can't find a match it relaxes the softest constraint first — delivery window, then attributes, then category — and **says which constraint it dropped**. An agent that silently loosens your requirements is worse than one that fails.

### 2. Grow the basket (the merchant half)

A campaign orchestrator (`src/merchant/offers.ts`): cross-sell by catalog complement, tier upgrades, desk+chair bundles, volume breaks, free-shipping nudges.

The part that matters: **offers are generated freely but published only if they clear the merchant's own policy.** Every candidate is priced, its post-discount margin computed, and then gated against a margin floor, a per-offer discount ceiling, a basket discount cap, and a no-discount category list. Rejected offers are returned *with their rejection reason*, so "why didn't my campaign fire?" is answerable instead of mysterious.

And the growth half cannot buy its way past the buyer's cap: the agent re-runs the mandate gate on every candidate offer before accepting it. In the demo run you can watch it reject "Upgrade to MeshPro" specifically because the step-up would breach the mandate.

### 3. The spine: bounded, gated, explained, audited

**Bounded — a mandate, not a budget suggestion.** A mandate is the delegation of spending authority from a human to an agent, and it is narrow: per-transaction cap, lifetime cap, category allowlist, max units per line, an expiry, and an amount above which a human must approve. An agent with no mandate can do nothing that costs money. Spend is committed against the lifetime cap when an order settles, so the cap is real across the mandate's life, not just per transaction.

**Gated — one pure function guards every money action.** `evaluatePurchase` is integer arithmetic and string comparison. No I/O, no network, no model. If you can't read it top to bottom and predict the verdict, it has no business guarding a payment. Two deliberate choices:

- It collects **all** deny reasons rather than short-circuiting. "Denied" teaches an agent nothing; "denied because you're over the per-transaction cap *and* the category isn't on the allowlist" is actionable.
- `REQUIRE_APPROVAL` is a first-class outcome, not an error. An order above the threshold parks in `awaiting_approval` and waits for a human. That's the system working.

The same gate guards discounting (`evaluateOffer`) and refunds (`evaluateRefund`). An over-eager discount engine is just unbudgeted spend with better branding.

**Explained — every decision carries its reasons.** Each verdict returns reason codes with the evidence that produced them, so any decision can be re-derived months later from the audit trail alone.

**Audited — a hash-chained, append-only ledger.** Every money-relevant action is appended to a ledger where each entry commits to its predecessor's hash. Tamper-*evident*, not merely tamper-*resistant*: edit or delete any historical entry and verification breaks for everything after it. There is no `UPDATE` and no `DELETE` path — recovery from a bad state happens by appending a correcting entry, never by rewriting history. `GET /api/v1/ledger/verify` recomputes the whole chain from genesis.

**Degraded, not broken — untrusted input stays untrusted.** The natural-language parser's output is schema-validated, clamped to sane ranges, restricted to a known attribute allowlist and wrapped in an 8-second timeout. Any failure — HTTP error, malformed JSON, schema violation, slow response — falls back to the deterministic parser and records `degradedFrom: "llm"` in the audit trail. A degraded parse is therefore visible in the ledger rather than silently trusted, and the system runs correctly with no API key at all.

---

## The failure I handle gracefully

**A payment succeeds at the gateway and the webhook never arrives.**

This is the failure that matters, because it is invisible from the inside. Your order row says `payment_pending`. The gateway says `captured`. The merchant has been paid. Your system believes otherwise, and nothing will ever correct it, because the thing that would have corrected it is the notification that got lost.

In production this is non-deterministic and essentially untestable against a live gateway. So I made it a switch.

```
POST /api/v1/simulator/faults   {"dropNextWebhook": true}
POST /api/v1/orders/:id/pay
POST /api/v1/simulator/pay      {"orderId": "..."}
GET  /api/v1/commerce/orders/:id   →  status: payment_pending   ← money has moved
POST /api/v1/orders/:id/reconcile  →  recovered, attempt 3      ← resolved
```

### How the recovery works

`reconcile()` treats **the gateway as the source of truth and our own row as a possibly-stale cache.** It asks Razorpay directly what payments exist for the order and resolves deterministically:

| Situation | Resolution |
|---|---|
| Captured payment, amount matches | Mark paid. Append `payment.captured` with `via: "reconciliation"`. |
| Captured payment, amount **doesn't** match | **Hold for human review.** Never auto-complete a short payment — that's how reconciliation bugs become revenue leaks. |
| Gateway reports failure | Mark failed, release reserved stock back to the catalog. |
| Nothing captured, payment window elapsed | Abandon, release stock. |
| Gateway unreachable | Record and retry. |
| Still nothing | Leave it. A background sweeper runs every 30s. |

Three properties make this safe rather than merely functional:

- **Idempotent.** Reconciling a settled order returns `already_final`. Recovery can never become a second charge.
- **Bounded.** It stops after 5 consecutive *gateway errors* and escalates to a human. The system refuses to guess whether money moved.
- **Patient.** It counts failures to reach the gateway, not total polls — see below.

Two smaller properties that matter as much:

- **Idempotency is enforced at the database level**, by a `UNIQUE` constraint on `idempotency_key`, not by an application-level "have we seen this?" check that races. A client retrying after a timeout gets the original order back.
- **A timeout on order creation does not retry.** That state is genuinely ambiguous — the order may or may not exist. Retrying is how you get two orders. It records the ambiguity and defers to reconciliation.

---

## What broke while building it

The three bugs worth reporting are all cases where my own tooling caught me.

**1. The audit chain reported itself broken, correctly.** The first `verify()` run failed: *"Entry 20 content does not match its recorded hash."* The `intent.parsed` payload contained `maxShipsInDays: undefined`. `JSON.stringify` silently drops object keys whose value is `undefined`, so I was hashing one string and later re-hashing a different one — a permanently broken chain from a value that isn't even there. Fixed by normalising the payload through a JSON round-trip **before** hashing, so what's hashed is byte-identical to what's persisted. There's a regression test for it. The verification tool earning its keep on its first run is the best argument for having built it.

**2. The confidence floor was below the starting confidence.** Vague requests scored 0.45 against a rejection floor of 0.4, so a request we understood *nothing* about would still clear the gate and spend money. The base is now 0.25 and every point above it has to be earned by something actually extracted. "thing" now scores 0.35 and is refused.

**3. The reconciliation patience bug.** Testing showed a stuck order burning all 5 attempts while the buyer had simply not paid yet. The budget conflated "no money has moved" with "we cannot tell whether money moved" — and those are not the same emergency. One is Tuesday, the other is a human's problem. Now: escalation counts consecutive gateway errors only, and there's a 45-second grace period after checkout during which we don't ask at all (and don't count it as an attempt).

---

## Live Razorpay test mode

With test-mode keys in `.env`, `createOrder`, `fetchOrder`, `fetchPaymentsForOrder` and `refund` all hit the real Razorpay test API. Webhook HMAC verification uses a constant-time comparison against the **raw** request body — the webhook router is mounted before the JSON parser, because re-serialising a parsed body before checking a signature verifies nothing.

Completing a payment in test mode needs a hosted checkout or a test instrument, so the fault-injection steps stay on the simulator. Run `RAZORPAY_FORCE_SIMULATOR=true npm run demo` to exercise them with real credentials loaded.

The simulator is not a stub I hid for lack of keys. It's the fault-injection harness, and it stays in the codebase on purpose.

---

## Architecture

```
src/
├── domain/
│   ├── money.ts          integer-paise arithmetic. No floats, anywhere.
│   └── types.ts          Product, Mandate, Order, Offer, PurchaseIntent
├── governance/
│   ├── policy.ts         the gate — pure functions, ALLOW/DENY/REQUIRE_APPROVAL
│   ├── ledger.ts         hash-chained append-only audit trail
│   └── mandates.ts       issuance and revocation of spending authority
├── catalog/
│   ├── repository.ts     SQLite catalog; atomic stock reservation
│   ├── feed.ts           agent-readable manifest + product feed + llms.txt
│   └── seed.ts           14 SKUs for "Bengaluru Ergo"
├── merchant/
│   └── offers.ts         campaign orchestrator, gated by merchant policy
├── commerce/
│   ├── gateway.ts        the PaymentGateway interface + fault config
│   ├── razorpay.ts       real test-mode SDK adapter
│   ├── simulator.ts      in-memory Razorpay with injectable failures
│   └── orders.ts         lifecycle, idempotency, reconciliation
├── agent/
│   ├── intent.ts         NL → typed intent; LLM with deterministic fallback
│   └── buyer.ts          plan → discover → evaluate → offer → gate → pay
├── api/routes.ts         REST + webhook handler
└── db.ts                 schema and migrations
```

**Stack:** Node 22, TypeScript strict, Express, SQLite via better-sqlite3 (WAL). No framework on the front end — the dashboard is one HTML file, one CSS file, one JS file, no build step.

---

## Testing

`npm test` — 34 assertions, no framework, runs in about a second.

Coverage is concentrated on the properties that make money safe:

- Integer-paise arithmetic, including the float-drift counter-example. Money is
  `number & {__brand: "Paise"}` throughout, so a rupee value cannot be passed
  where paise are expected without the compiler objecting. Ten additions of
  ₹0.10 land on exactly 10 paise; the float version does not.
- Every gate outcome, including expired and revoked mandates
- Collecting all deny reasons rather than short-circuiting
- Idempotency actually preventing a second charge
- Overselling being impossible (and stock restored on failure)
- Reconciliation: dropped webhook, amount mismatch, failed payment, patience, grace period
- Ledger: tampering detected, deletion detected, the `undefined`-key regression

---

## What I'd build next

- **Partial captures.** A short payment currently parks for a human. The right resolution is a bounded choice: accept the shortfall, cancel and refund, or request the balance.
- **Delegated sub-mandates.** A buying agent should be able to issue a narrower mandate to a sub-agent, with the chain of authority recorded in the ledger.
- **Signed mandates.** The principal should sign the mandate cryptographically so it can be verified offline by the merchant.
- **Real UAP/ACP wire format.** The manifest is shaped like the emerging protocols; adopting an actual spec is the obvious next step once one stabilises.

---

MIT licensed.
