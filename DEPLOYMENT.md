# Deployment — Vyapaar live demo

This gets the Vyapaar dashboard, agent manifest and product feed running on a
**public URL** so anyone can click through the whole flow without
cloning anything.

The plan:

1. **GitHub Actions secrets** hold your Razorpay test keys and run a CI check
   that exercises the real adapter (`verify:razorpay`). This is the real,
   working use of "add the keys to GitHub env variables" — the keys are stored
   encrypted in GitHub and used by CI; they are never written to disk in the
   repo.
2. **Render** hosts the running server. Render auto-deploys on every push to
   `main`. The running server needs the same two keys in *its own* environment
   (a host cannot read GitHub Actions secrets at runtime), so you paste them
   once into the Render dashboard.

> Why two places? GitHub repository secrets are inert by themselves — they only
> reach a workflow or a host that pulls them. CI reads them; the live server
> reads them from the host's env. Both get the same two values.

---

## Step 1 — Add the Razorpay keys to GitHub (for CI)

1. Open the repo: **Settings → Secrets and variables → Actions → New repository secret**.
2. Add two secrets:
   - `RAZORPAY_KEY_ID` → `rzp_test_xxxxxxxxxxxx` (your Key ID from the Razorpay dashboard)
   - `RAZORPAY_KEY_SECRET` → your test secret
3. Push any commit (or just re-run the workflow). Go to the **Actions** tab —
   you should see a green run, and the "Verify Razorpay adapter" step will have
   exercised the live test-mode adapter.

These are **test-mode** keys (`rzp_test_`). They cannot move real money and are
safe to keep in CI. Rotate them once you're done anyway (see bottom).

---

## Step 2 — Deploy to Render (the live host)

1. Sign in to **render.com** with your GitHub account.
2. **New → Blueprint** (this reads `render.yaml` from the repo).
3. Select the **Vyapaar** repository. Render fills in the service from the
   Blueprint: Node 22, `npm install && npm run build`, `npm start`, health check
   at `/api/v1/status`.
4. You'll be prompted for the `sync: false` env vars. Enter:
   - `RAZORPAY_KEY_ID` → `rzp_test_xxxxxxxxxxxx` (your Key ID from the Razorpay dashboard)
   - `RAZORPAY_KEY_SECRET` → your test secret
   - `RAZORPAY_WEBHOOK_SECRET` → leave **blank** for now
   - `PUBLIC_URL` → leave blank for now (set after first deploy)
   - The rest (`RAZORPAY_FORCE_SIMULATOR=false`, `LLM_FORCE_HEURISTIC=true`,
     `PORT`) are already set by the Blueprint.
5. Click **Create Web Service**. Wait for the build (native `better-sqlite3`
   compiles during install — a couple of minutes).
6. Once live, Render gives you a URL like `https://vyapaar-agent.onrender.com`.
   Copy it, go back to the service **Environment** tab, and set
   `PUBLIC_URL=https://vyapaar-agent.onrender.com`, then **Save** and let it
   redeploy. This makes the advertised manifest/feed URLs absolute and correct.

Your live endpoints:

- Dashboard: `https://vyapaar-agent.onrender.com/`
- Agent manifest: `https://vyapaar-agent.onrender.com/.well-known/agent-commerce.json`
- Product feed: `https://vyapaar-agent.onrender.com/api/v1/feed/products`
- Health/status: `https://vyapaar-agent.onrender.com/api/v1/status`

---

## Step 3 — Verify the live deployment

```bash
curl https://vyapaar-agent.onrender.com/api/v1/status
```

You should see `"ok": true`, `"payments": "razorpay-live-test-mode"` and a
non-zero product count (the catalog auto-seeds on first boot).

Open the dashboard in an incognito window and walk the flow: pick a product →
get a quote (gated) → create an order (this calls **real** Razorpay test mode
and shows an `order_...` id) → run the dropped-webhook recovery demo.

---

## What the live demo shows vs. what it can't

- **Shows:** real test-mode order creation (`order_...`), the policy gate
  rejecting/approving with reasons, the hash-chained audit ledger, and the
  dropped-webhook reconciliation (idempotent recovery from the gateway).
- **Cannot auto-complete on its own:** capturing a test payment needs either
  Razorpay hosted checkout or a manual test instrument — neither of which an
  autonomous agent can drive. That is by design (bounded autonomy: the agent
  creates the order and is gated; a human completes the capture). This is
  explained honestly in `FLOW.md`.

---

## Webhooks (optional)

Webhooks need a **stable public URL** (Render gives you one) and a
`RAZORPAY_WEBHOOK_SECRET`:
1. In the Razorpay dashboard (test mode) create a webhook pointing at
   `https://vyapaar-agent.onrender.com/api/v1/webhooks/razorpay` for the
   `payment.captured` / `order.paid` events.
2. Copy the webhook secret into Render's `RAZORPAY_WEBHOOK_SECRET`.
Without it, incoming webhooks are rejected (fail-closed) rather than trusted
blindly — exactly the safety posture the project argues for.

---

## Alternatives to Render

- **Railway:** add a `railway.toml` (or let it auto-detect) and connect the
  repo; set the same env vars in the Railway project. Needs a payment method.
- **Koyeb:** free tier that does not sleep; connect GitHub, set env vars.
- Any Node host works — `npm run build` then `node dist/server.js`, honoring
  `PORT`. The app binds all interfaces by default.

---

## Important notes

- **Ephemeral database:** on Render's free plan the filesystem resets on each
  deploy, so `data/vyapaar.db` (catalog + ledger) is recreated and re-seeded on
  boot. That's fine for a demo. If you want the audit trail to persist, attach a
  Render **Persistent Disk** and set `DB_PATH` to a path on it.
- **Rotate the keys when you're done:** generate a fresh test-mode key pair in
  the Razorpay dashboard and update both the GitHub secret and the Render env
  var. Test keys can't move real money, but good hygiene still applies — and any
  key that has been shared or pasted anywhere should be treated as public.
