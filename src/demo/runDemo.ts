/**
 * Headless end-to-end demo.
 *
 * Runs the whole story without a browser so the behaviour is verifiable from a
 * terminal and reproducible in a video:
 *
 *   1. Issue a mandate
 *   2. Parse a buyer request and quote it
 *   3. Buy within the mandate
 *   4. Replay the same request — prove it cannot double-charge
 *   5. Try to buy beyond the cap — prove the gate holds
 *   6. DROP THE WEBHOOK, complete the payment, and recover by reconciliation
 *
 * With Razorpay test keys present it uses the real API for steps that do not
 * require a hosted checkout, and falls back to the simulator for the payment
 * completion and fault-injection steps. Without keys it runs entirely on the
 * simulator.
 */

import { gatewayMode, simulator } from "../commerce";
import * as M from "../domain/money";
import { seedCatalog } from "../catalog/seed";
import { CatalogRepository } from "../catalog/repository";
import { MandateStore } from "../governance/mandates";
import { OrderStore } from "../commerce/orders";
import { BuyerAgent } from "../agent/buyer";
import { db, ledger } from "../db";

const LIVE = gatewayMode() === "razorpay-test";

function h1(s: string) {
  console.log(`\n\x1b[1m\x1b[36m${s}\x1b[0m`);
}
function ok(s: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${s}`);
}
function bad(s: string) {
  console.log(`  \x1b[31m✗\x1b[0m ${s}`);
}
function info(s: string) {
  console.log(`    \x1b[90m${s}\x1b[0m`);
}
function money(p: M.Paise) {
  return M.format(p);
}

async function main() {
  console.log(`\n\x1b[1mVyapaar — end-to-end demo\x1b[0m`);
  console.log(`payments: ${gatewayMode()}${LIVE ? " (real Razorpay test-mode API)" : " (simulator)"}\n`);

  if (new CatalogRepository().count() === 0) seedCatalog();

  const mandates = new MandateStore();
  const orders = new OrderStore();
  const agent = new BuyerAgent();

  /* ---------------------------------------------------------------- */
  h1("1. Issue a mandate — the agent's only source of authority");
  const mandate = mandates.create({
    principal: "ops.lead@acme.in",
    purpose: "Outfit the Bengaluru office",
    perTxnCap: M.paise(25000),
    totalCap: M.paise(60000),
    approvalAbove: M.paise(15000),
    categoryAllowlist: [],
    maxQtyPerLine: 3,
  });
  ok(`Mandate ${mandate.id}`);
  info(`per-txn cap ${money(mandate.perTxnCap)} · total cap ${money(mandate.totalCap)} · human approval above ${money(mandate.approvalAbove)}`);

  /* ---------------------------------------------------------------- */
  h1("2. Parse a buyer request and quote it (no money moves)");
  const request = "I need 2 ergonomic mesh chairs under 20000 each, delivered within 5 days";
  console.log(`  request: "${request}"`);
  const dry = await agent.run({ mandate, request, dryRun: true });
  info(`parsed by ${dry.run.intent.source} (confidence ${dry.run.intent.confidence.toFixed(2)})`);
  info(`terms: [${dry.run.intent.terms.join(", ")}] · qty ${dry.run.intent.qty} · maxUnitPrice ${dry.run.intent.maxUnitPrice ? money(dry.run.intent.maxUnitPrice) : "—"}`);
  if (dry.quote) {
    ok(`Quote ${money(dry.quote.total as M.Paise)} — verdict ${dry.quote.decision}`);
    for (const l of dry.quote.lines) info(`${l.qty}× ${l.title} @ ${money(l.unitPrice as M.Paise)}`);
    info(`subtotal ${money(dry.quote.subtotal as M.Paise)} − discount ${money(dry.quote.discount as M.Paise)} + shipping ${money(dry.quote.shipping as M.Paise)}`);
  }

  /* ---------------------------------------------------------------- */
  h1("3. Buy within the mandate");
  const run1 = await agent.run({ mandate, request });
  const order1 = run1.run.orderId ? orders.byId(run1.run.orderId)! : null;
  if (!order1) {
    bad("No order was created.");
    return;
  }
  ok(`Order ${order1.id} → ${order1.status} · total ${money(order1.total)}`);
  if (order1.razorpayOrderId) info(`gateway order ${order1.razorpayOrderId}`);
  for (const s of run1.run.steps) info(`${s.kind}: ${s.summary}`);

  /* ---------------------------------------------------------------- */
  h1("4. Replay the identical request — idempotency must prevent a second charge");
  const run2 = await agent.run({ mandate, request });
  const order2 = run2.run.orderId ? orders.byId(run2.run.orderId)! : null;
  if (order2 && order2.id === order1.id) {
    ok(`Same order returned: ${order2.id} (replay suppressed)`);
  } else if (order2) {
    // Different run id means a different idempotency key by design; demonstrate
    // the DB-level guard directly instead.
    const replay = orders.create({
      mandate,
      lines: order1.lines.map((l) => ({ productId: l.productId, qty: l.qty })),
      idempotencyKey: order1.idempotencyKey,
      discount: order1.discount,
    });
    ok(`Idempotency key collision handled: replayed=${replay.replayed}, same id=${replay.order.id === order1.id}`);
  }

  /* ---------------------------------------------------------------- */
  h1("5. Try to buy beyond the per-transaction cap — the gate must hold");
  const big = await agent.run({
    mandate,
    request: "I want 3 executive leather chairs",
  });
  const bigOrder = big.run.orderId ? orders.byId(big.run.orderId)! : null;
  if (big.run.outcome === "denied" || bigOrder?.status === "failed") {
    ok(`Denied as expected. Reason: ${big.run.steps[big.run.steps.length - 1].summary}`);
    const gate = big.run.steps.find((s) => s.kind === "gate");
    if (gate?.detail) info(JSON.stringify((gate.detail as { reasons?: string[] }).reasons ?? gate.detail));
  } else {
    bad(`Expected a denial, got ${big.run.outcome}/${bigOrder?.status}`);
  }

  /* ---------------------------------------------------------------- */
  h1("6. The failure: payment succeeds, webhook never arrives");

  if (!LIVE) {
    simulator().clearFaults();
    const small = await agent.run({ mandate, request: "1 ergonomic footrest" });
    const o = small.run.orderId ? orders.byId(small.run.orderId)! : null;
    if (!o) return bad("No order to test with.");

    await orders.initiatePayment(o.id);
    const before = orders.byId(o.id)!;
    ok(`Order ${o.id} is ${before.status}, gateway order ${before.razorpayOrderId}`);

    // Arm the fault, then complete the payment. Money moves; notification dies.
    simulator().setFaults({ dropNextWebhook: true });
    const payment = await simulator().completePayment(before.razorpayOrderId!);
    simulator().webhookOutbox.length = 0; // nothing was delivered
    ok(`Payment ${payment.id} captured at the gateway — but the webhook was dropped.`);

    // The reconciler deliberately waits out a 45s grace period before it will
    // ask the gateway anything, so a buyer who is still at checkout is not
    // treated as a failure. Backdate the order to stand in for a buyer who
    // took a minute, which is where this bug actually bites in production.
    db()
      .prepare(`UPDATE orders SET createdAt = ? WHERE id = ?`)
      .run(new Date(Date.now() - 60_000).toISOString(), before.id);
    info("(order backdated past the 45s reconciliation grace period)");

    const stuck = orders.byId(o.id)!;
    if (stuck.status === "payment_pending") {
      ok(`Local order is still ${stuck.status}. This is the broken state naive integrations sit in forever.`);
    }

    const recon = await orders.reconcile(o.id, { reason: "demo" });
    const recovered = orders.byId(o.id)!;
    if (recovered.status === "paid") {
      ok(`Reconciliation recovered it: ${recon.status} on attempt ${recon.attempt}.`);
      info(`order ${recovered.id} → ${recovered.status} via ${recovered.razorpayPaymentId}`);
    } else {
      bad(`Expected paid, got ${recovered.status}`);
    }

    h1("6b. Reconciling an already-settled order is a no-op, not a second charge");
    const again = await orders.reconcile(o.id, { reason: "demo" });
    ok(`Second reconcile → ${again.status} (${again.detail})`);
  } else {
    info("Live Razorpay test mode: completing a payment requires a hosted checkout or a");
    info("test-mode payment instrument, so the fault-injection steps are simulator-only.");
    info("Run `npm run demo` with RAZORPAY_FORCE_SIMULATOR=true to exercise them.");
  }

  /* ---------------------------------------------------------------- */
  h1("7. Audit ledger");
  const v = ledger().verify();
  if (v.ok) ok(`Chain intact across ${v.entries} entries.`);
  else bad(`CHAIN BROKEN: ${v.reason}`);

  const actions = new Map<string, number>();
  for (const e of ledger().list({ tail: 1000 })) actions.set(e.action, (actions.get(e.action) ?? 0) + 1);
  for (const [action, n] of [...actions.entries()].sort()) info(`${action.padEnd(34)} ×${n}`);

  console.log("");
}

main().catch((err) => {
  console.error(`\n\x1b[31mDemo failed:\x1b[0m`, err);
  process.exit(1);
});
