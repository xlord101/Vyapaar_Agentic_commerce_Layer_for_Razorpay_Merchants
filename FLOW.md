# Vyapaar — how the whole thing actually flows

Plain-language reference for how the system works end to end.
Reads alongside `README.md` (technical detail).

---

## 1. Three things people get wrong

**"The agent searches the internet for merchants."**
It does not. There is no web crawl and no search index in this project. The
agent is *given* a merchant domain and reads a file at a well-known path on it:
`/.well-known/agent-commerce.json`. That is a convention, exactly like
`robots.txt` or `sitemap.xml`.

How an agent discovers merchants across the whole internet is a **directory
problem the industry has not solved**, and this project does not pretend to.
Google does not find sites by scanning random IP addresses — it uses links,
submitted sitemaps and registries. Agentic commerce will need the same. What we
built is the narrower, honest piece: *given a merchant, make them transactable.*

What the agent **does** search is one merchant's catalog (`search()`, with match
scores) — not the web.

**"Merchants need a Razorpay payment window."**
There is no checkout popup. In agentic commerce there is no human to click one.
Payment is a **server-side Razorpay order** plus a tokenised / saved instrument
or UPI. An agent cannot drive a hosted checkout page.

**"Verification happens on the merchant side after they receive payment."**
There are **two different verifications**, and a third thing that is commonly
called verification but actually happens *before* the money moves. See §5.

---

## 2. Who owns what

**Shopper's side.** A human issues a **mandate** to their agent. The agent holds
no money of its own — only permission: per-transaction cap, lifetime cap,
category allowlist, max units per line, expiry, and an amount above which a
human must approve. With no mandate the agent can do nothing that costs money.

**Merchant's side.** The merchant runs Vyapaar beside their store. It publishes
what agents need — capability manifest, typed product feed, `llms.txt` — and
encodes the merchant's own policy: margin floor, per-offer discount ceiling,
basket discount cap, categories that never discount. They keep a Razorpay
account exactly as they do today.

The agent never reads the merchant's HTML. It reads the manifest.

---

## 3. The timeline of one purchase

**1 · Before any money moves.** The mandate gate returns ALLOW, DENY or HOLD.
The merchant policy gate prices every offer against the margin floor and
rejects the ones that would lose money. Both gates are pure functions — integer
arithmetic and string comparison, no model, no network, no I/O.

**2 · Money moves.** Vyapaar creates a Razorpay order server-side, reserves
stock atomically, and the saved instrument is charged.

**3 · Confirming that it actually moved.** A HMAC-signed webhook arrives — or it
never does, and reconciliation asks Razorpay directly instead.

**4 · Throughout.** Every money-relevant action is appended to the hash-chained
ledger, including the rejections.

---

## 4. What the merchant actually does

Short answer: **very little, and none of it is manual.**

1. They configure their policy **once** — margin floor, discount ceilings,
   no-discount categories.
2. Vyapaar enforces it automatically **before a quote or offer is ever
   published**. The agent cannot negotiate around it, because it is not in a
   prompt — it is a function that runs on every candidate.
3. Money arrives through **normal Razorpay settlement**. No special handling,
   no separate reconciliation ritual.
4. They get the audit trail, and rejected offers come back **with their
   rejection reason**, so "why didn't my campaign fire?" is answerable.

The merchant-side protection that matters is **preventive, not detective**: the
discount is never offered in the first place if it breaks the margin floor.

---

## 5. The two verifications (and the thing that isn't one)

| | Payment verification | Audit verification |
|---|---|---|
| Asks | Did the money actually move? | Has anyone edited the history? |
| Truth | **Razorpay**, not our database | The hash chain itself |
| When | After every payment attempt | Any time — `GET /api/v1/ledger/verify` |
| Failure | Webhook lost → reconciliation | Edit one entry → all later ones fail |
| Attitude | Never guess — escalate to a human | Recovery appends, never rewrites |

**The third thing** — the mandate and policy check — is not verification at all.
It is a **gate that runs before the money moves**. Calling it verification is
what makes the whole flow confusing.

Reconciliation safety properties, in the order that matters:
- **Idempotent** — reconciling a settled order returns `already_final`. Recovery
  can never become a second charge.
- **Bounded** — stops after 5 consecutive *gateway errors*, then escalates.
- **Patient** — counts failures to *reach* Razorpay, not total polls; 45s grace
  after checkout during which we don't ask at all.
- **Never auto-completes a short payment.** Amount mismatch → hold for a human.
  That is how reconciliation bugs become revenue leaks.

---

## 6. Razorpay test mode — the honest status

What **exists** — `src/commerce/razorpay.ts`, a complete adapter, not a stub:

- `createOrder`, `fetchOrder`, `fetchPaymentsForOrder`, `refund`
- `verifyWebhookSignature` — constant-time HMAC against the **raw** body
- Error mapping: `401 → AUTH_ERROR` (not retryable), `429/5xx → TRANSIENT`
  (retryable), `400 not-found → NOT_FOUND`
- Paise integers throughout, 40-character receipt cap

How it activates:

```ts
razorpayEnabled() = keyId && keySecret && !forceSimulator
```

So the adapter is live as soon as `rzp_test_` keys are present in `.env` and
`RAZORPAY_FORCE_SIMULATOR` is not `true`. With no keys the same code path falls
back to the simulator, and every test still passes — running without
credentials is a supported mode, not a degraded one.

### Verifying it

`npm run verify:razorpay` exercises the adapter against the live test-mode API
and checks the one property that is easy to get wrong and catastrophic to get
wrong: **the paise round-trip**. Razorpay speaks paise; sending rupees creates
an order for one hundredth of the intended price, and nothing downstream will
catch it. The script creates a ₹199.00 order, reads it back, and asserts the
amount is byte-identical in paise. It deliberately ignores
`RAZORPAY_FORCE_SIMULATOR`, because it is explicitly asking whether the real
adapter works.

Covered: `createOrder`, `fetchOrder`, and `fetchPaymentsForOrder` — the last of
which is the exact call reconciliation makes when a webhook never arrives.

### The important nuance

Even with test keys, **an agent still cannot complete a payment**. In Razorpay
test mode, capturing a payment needs either a hosted checkout (a human clicks)
or a test instrument (a card or UPI entered by hand). An agent can do neither.

So with keys you could verify:

- `createOrder` — yes
- `fetchOrder` — yes
- `fetchPaymentsForOrder` — yes, **this is the reconciliation primitive**
- `refund` — implemented, but not exercised end-to-end: there is no captured
  payment to refund, because capturing one needs a human (see above)
- webhook capture → the dropped-webhook recovery end-to-end — **still no**

That is exactly why `RAZORPAY_FORCE_SIMULATOR=true` exists: to keep the
fault-injection demo on the simulator even when real credentials are loaded.

---

## 7. Operating it

```bash
npm install
npm run dev             # dashboard at http://localhost:8787
npm test                # 34 assertions, about a second
npm run demo            # the whole story in your terminal
npm run verify:ledger   # recompute the chain from genesis
npm run typecheck       # strict TS, must be clean
```

The dashboard is three columns: **mandates and fault switches on the left**,
**the policy and buyer request in the middle**, **the audit trail on the right**.
Badges at the top show payment mode, parser mode and ledger status.

### Turning on real Razorpay test mode

1. `dashboard.razorpay.com` → switch the dashboard to **Test mode** →
   Settings → API Keys → generate a key pair (`rzp_test_…`).
2. `cp .env.example .env` and fill `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
3. Create a webhook in the dashboard pointing at
   `/api/v1/webhooks/razorpay`, and copy its signing secret into
   `RAZORPAY_WEBHOOK_SECRET`. Without it, incoming webhooks are rejected rather
   than trusted blindly.
4. Restart. The banner now reads `payments: razorpay-test (real Razorpay
   test-mode API)`.

**One operational catch:** Razorpay cannot deliver webhooks to `localhost`. You
need a public URL — `ngrok http 8787` or Cloudflare Tunnel — and to set
`PUBLIC_URL` to it. This is the single most common reason "the webhook isn't
working" on a first attempt.

---

## 8. What this project deliberately does not do

Say these before someone else does:

- **No cross-merchant discovery.** No registry, no index, no web search.
- **No real protocol implementation.** The manifest is *shaped toward* where
  ACP / AP2 / UAP are converging, but it is not a conformant implementation of
  any of them.
- **No partial captures.** A short payment parks for a human rather than being
  resolved.
- **No sub-mandates.** An agent cannot yet delegate a narrower mandate to a
  sub-agent.
- **No signed mandates.** The principal cannot yet cryptographically sign the
  delegation so a merchant could verify it offline.
- **Single merchant instance.** One catalog, one policy, one Razorpay account.
