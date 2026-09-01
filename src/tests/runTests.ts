/**
 * Test suite. No framework — a handful of assertions and a clean database is
 * enough, and it keeps `npm test` instant.
 *
 * These tests exist because the properties they check are the ones that make
 * money safe: floats never touch an amount, the gate holds, idempotency
 * actually prevents a second charge, reconciliation actually recovers, and the
 * audit chain detects tampering.
 */

import "./setup"; // must precede anything that opens the database

import * as M from "../domain/money";
import { db, ledger, resetDatabase } from "../db";
import type { Mandate } from "../domain/types";
import { evaluatePurchase, evaluateOffer } from "../governance/policy";
import { MandateStore } from "../governance/mandates";
import { CatalogRepository } from "../catalog/repository";
import { seedCatalog } from "../catalog/seed";
import { generateOffers, DEFAULT_MERCHANT_POLICY, marginOf, priceLines, subtotalOf } from "../merchant/offers";
import { OrderStore } from "../commerce/orders";
import { simulator } from "../commerce";
import { BuyerAgent } from "../agent/buyer";
import { heuristicParse } from "../agent/intent";
import { computeHash, normalizePayload, canonical } from "../governance/ledger";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  const run = () => {
    try {
      const r = fn();
      if (r instanceof Promise) return r.then(() => done(name), (e: Error) => fail(name, e));
      done(name);
    } catch (e) {
      fail(name, e as Error);
    }
  };
  queue.push(run);
}

const queue: Array<() => Promise<void> | void> = [];

function done(name: string) {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}
function fail(name: string, e: Error) {
  failed++;
  failures.push(`${name}: ${e.message}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${e.message}\x1b[0m`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq(a: unknown, b: unknown, msg = `${a} !== ${b}`) {
  if (a !== b) throw new Error(msg);
}

/* ================================================================== */

/**
 * Pretend an order was created longer ago than it was, so tests can exercise
 * reconciliation without waiting out the real grace period.
 */
function ageOrder(id: string, ms = 120_000): void {
  db().prepare(`UPDATE orders SET createdAt = ? WHERE id = ?`).run(new Date(Date.now() - ms).toISOString(), id);
}

function makeMandate(overrides: Partial<Mandate> = {}): Mandate {
  const store = new MandateStore();
  return store.create({
    principal: "test@acme.in",
    purpose: "test mandate",
    perTxnCap: overrides.perTxnCap ?? M.paise(20000),
    totalCap: overrides.totalCap ?? M.paise(60000),
    approvalAbove: overrides.approvalAbove ?? M.paise(10000),
    maxQtyPerLine: overrides.maxQtyPerLine ?? 3,
    categoryAllowlist: overrides.categoryAllowlist ?? [],
    validHours: 24,
  });
}

/* ---------- money ---------- */

test("money: rupees parse to integer paise without float drift", () => {
  eq(M.toInt(M.paise(1999.1)), 199910);
  eq(M.toInt(M.paise("18499")), 1849900);
  eq(M.toInt(M.paiseFromDecimal("1299.05")), 129905);
  eq(M.toInt(M.paiseFromDecimal("0.10")), 10);
});

test("money: 12.5% of 1999 rounds to a whole paisa", () => {
  const v = M.applyBps(M.paise(1999), 1250);
  eq(M.toInt(v), 24988); // 1999.00 * 0.125 = 249.875 -> 249.88
  assert(Number.isInteger(M.toInt(v)), "bps result must be an integer number of paise");
});

test("money: repeated float addition would drift, integer paise does not", () => {
  let f = 0;
  for (let i = 0; i < 10; i++) f += 0.1;
  let p = M.paise(0);
  for (let i = 0; i < 10; i++) p = M.add(p, M.paise(0.1));
  eq(M.toInt(p), 100, "ten paise added ten times is exactly 100 paise");
  assert(f !== 1.0, "sanity: the float version really does drift");
});

test("money: formatting is stable", () => {
  eq(M.format(M.paise(1999)), "₹1,999.00");
  eq(M.format(M.paise(1234567.89)), "₹12,34,567.89");
  eq(M.format(M.paise(0)), "₹0.00");
});

/* ---------- policy ---------- */

test("policy: within mandate is ALLOW", () => {
  const m = makeMandate();
  const v = evaluatePurchase(m, { total: M.paise(5000), categories: ["seating"], maxLineQty: 1 });
  eq(v.decision, "ALLOW");
});

test("policy: above approval threshold is REQUIRE_APPROVAL, not ALLOW", () => {
  const m = makeMandate({ approvalAbove: M.paise(10000) });
  const v = evaluatePurchase(m, { total: M.paise(12000), categories: [], maxLineQty: 1 });
  eq(v.decision, "REQUIRE_APPROVAL");
  assert(v.reasons[0].code === "ABOVE_APPROVAL_THRESHOLD", "reason code should name the trigger");
});

test("policy: over per-transaction cap is DENY", () => {
  const m = makeMandate({ perTxnCap: M.paise(20000) });
  const v = evaluatePurchase(m, { total: M.paise(20001), categories: [], maxLineQty: 1 });
  eq(v.decision, "DENY");
  assert(v.reasons.some((r) => r.code === "PER_TXN_CAP_EXCEEDED"), "should cite the per-txn cap");
});

test("policy: over total cap is DENY with remaining authority in the evidence", () => {
  const m = makeMandate({ totalCap: M.paise(30000) });
  const spent: Mandate = { ...m, spent: M.paise(25000) };
  const v = evaluatePurchase(spent, { total: M.paise(6000), categories: [], maxLineQty: 1 });
  eq(v.decision, "DENY");
  const r = v.reasons.find((x) => x.code === "TOTAL_CAP_EXCEEDED");
  assert(r, "should cite the total cap");
  eq((r!.evidence as { remaining: number }).remaining, 500000);
});

test("policy: expired mandate is DENY even if everything else is fine", () => {
  const m = makeMandate();
  const expired: Mandate = { ...m, expiresAt: new Date(Date.now() - 1000).toISOString() };
  const v = evaluatePurchase(expired, { total: M.paise(100), categories: [], maxLineQty: 1 });
  eq(v.decision, "DENY");
  eq(v.reasons[0].code, "MANDATE_EXPIRED");
});

test("policy: revoked mandate is DENY", () => {
  const m = makeMandate();
  const v = evaluatePurchase({ ...m, status: "revoked" }, { total: M.paise(1), categories: [], maxLineQty: 1 });
  eq(v.decision, "DENY");
  eq(v.reasons[0].code, "MANDATE_REVOKED");
});

test("policy: category outside allowlist is DENY", () => {
  const m = makeMandate({ categoryAllowlist: ["seating"] });
  const v = evaluatePurchase(m, { total: M.paise(100), categories: ["desks"], maxLineQty: 1 });
  eq(v.decision, "DENY");
  eq(v.reasons[0].code, "CATEGORY_NOT_ALLOWED");
});

test("policy: collects ALL deny reasons rather than short-circuiting", () => {
  const m = makeMandate({ perTxnCap: M.paise(100), categoryAllowlist: ["seating"], maxQtyPerLine: 2 });
  const v = evaluatePurchase(m, { total: M.paise(5000), categories: ["desks"], maxLineQty: 9 });
  eq(v.decision, "DENY");
  assert(v.reasons.length >= 3, `expected at least 3 reasons, got ${v.reasons.length}`);
});

/* ---------- offers / merchant policy ---------- */

test("offers: a chair cart generates at least one allowed offer", () => {
  const { allowed } = generateOffers([{ productId: "ergo-chair-mesh-lite", qty: 2 }], new CatalogRepository());
  assert(allowed.length > 0, "expected at least one offer to clear policy");
});

test("offers: margin floor is never breached", () => {
  const catalog = new CatalogRepository();
  const { allowed } = generateOffers([{ productId: "ergo-chair-mesh-lite", qty: 2 }], catalog);
  for (const a of allowed) {
    assert(
      M.toInt(a.offer.projectedMargin) >= M.toInt(DEFAULT_MERCHANT_POLICY.minMarginPaise),
      `offer ${a.offer.ruleId} left margin ${a.offer.projectedMargin}, below the floor`,
    );
  }
});

test("offers: an excessive discount is rejected by the merchant policy", () => {
  const base = {
    id: "o1", kind: "bundle_discount" as const, ruleId: "r1", title: "t", rationale: "r",
    discount: M.paise(9000), lines: [], projectedMargin: M.paise(10),
  };
  const v = evaluateOffer(base, DEFAULT_MERCHANT_POLICY, {
    subtotal: M.paise(20000), basketDiscountSoFar: M.paise(0), categories: ["seating"],
  });
  eq(v.decision, "DENY");
  assert(v.reasons.some((r) => r.code === "MARGIN_FLOOR_BREACHED"), "should cite the margin floor");
});

test("offers: gift cards are never discounted", () => {
  const v = evaluateOffer(
    { id: "o2", kind: "bundle_discount", ruleId: "r2", title: "t", rationale: "r", discount: M.paise(100), lines: [], projectedMargin: M.paise(5000) },
    DEFAULT_MERCHANT_POLICY,
    { subtotal: M.paise(5000), basketDiscountSoFar: M.paise(0), categories: ["gift_cards"] },
  );
  eq(v.decision, "DENY");
  eq(v.reasons[0].code, "NO_DISCOUNT_CATEGORY");
});

/* ---------- intent ---------- */

test("intent: extracts qty, price ceiling and delivery window", () => {
  const i = heuristicParse("I need 3 ergonomic mesh chairs under 15000 each, delivered within 5 days");
  eq(i.qty, 3);
  eq(i.maxUnitPrice ? M.toInt(i.maxUnitPrice) : null, 1500000);
  eq(i.maxShipsInDays, 5);
  eq(i.category, "seating");
  eq(i.attributeFilters.material, "mesh");
});

test("intent: a vague request scores below the confidence floor", () => {
  const i = heuristicParse("thing");
  assert(i.confidence < 0.4, `expected low confidence, got ${i.confidence}`);
});

/* ---------- idempotency & stock ---------- */

test("orders: the same idempotency key never creates a second charge", () => {
  const m = makeMandate();
  const store = new OrderStore();
  const key = "test-key-double-charge";
  const a = store.create({ mandate: m, lines: [{ productId: "footrest-ergo", qty: 1 }], idempotencyKey: key });
  const b = store.create({ mandate: m, lines: [{ productId: "footrest-ergo", qty: 1 }], idempotencyKey: key });
  eq(a.order.id, b.order.id, "the same key must return the same order");
  eq(b.replayed, true, "the replay must be flagged");
  eq(store.list({ tail: 1000 }).filter((o) => o.idempotencyKey === key).length, 1);
});

test("orders: overselling is impossible", () => {
  const catalog = new CatalogRepository();
  const before = catalog.byId("exec-chair-leather")!.stock;
  const m = makeMandate({ perTxnCap: M.paise(10_000_000), totalCap: M.paise(50_000_000), approvalAbove: M.paise(10_000_000), maxQtyPerLine: 100 });
  const store = new OrderStore();
  const res = store.create({
    mandate: m,
    lines: [{ productId: "exec-chair-leather", qty: before + 100 }],
    idempotencyKey: "oversell-test",
  });
  eq(res.verdict.decision, "DENY");
  eq(res.order.status, "failed");
  eq(catalog.byId("exec-chair-leather")!.stock, before, "stock must be untouched after a failed reservation");
});

test("orders: successful reservation actually decrements stock", () => {
  const catalog = new CatalogRepository();
  const before = catalog.byId("footrest-ergo")!.stock;
  const m = makeMandate();
  new OrderStore().create({ mandate: m, lines: [{ productId: "footrest-ergo", qty: 2 }], idempotencyKey: "stock-decrement" });
  eq(catalog.byId("footrest-ergo")!.stock, before - 2);
});

/* ---------- reconciliation ---------- */

test("reconciliation: recovers an order whose webhook was dropped", async () => {
  simulator().clearFaults();
  const m = makeMandate();
  const store = new OrderStore();
  const { order } = store.create({ mandate: m, lines: [{ productId: "footrest-ergo", qty: 1 }], idempotencyKey: "recon-recover" });
  await store.initiatePayment(order.id);
  ageOrder(order.id);

  simulator().setFaults({ dropNextWebhook: true });
  await simulator().completePayment(store.byId(order.id)!.razorpayOrderId!);
  simulator().webhookOutbox.length = 0;

  eq(store.byId(order.id)!.status, "payment_pending", "order should still look unpaid");

  const r = await store.reconcile(order.id, { reason: "test" });
  eq(r.status, "recovered");
  eq(store.byId(order.id)!.status, "paid");
});

test("reconciliation: a second reconcile is a no-op, not a second charge", async () => {
  const store = new OrderStore();
  const order = store.list({ tail: 200 }).find((o) => o.idempotencyKey === "recon-recover")!;
  const r = await store.reconcile(order.id, { reason: "test" });
  eq(r.status, "already_final");
});

test("reconciliation: a brand-new order is not asked yet (grace period)", async () => {
  simulator().clearFaults();
  const m = makeMandate();
  const store = new OrderStore();
  const { order } = store.create({ mandate: m, lines: [{ productId: "desk-mat-xl", qty: 1 }], idempotencyKey: "recon-grace" });
  await store.initiatePayment(order.id);

  const r = await store.reconcile(order.id, { reason: "test" });
  eq(r.status, "too_early", "should not pester the gateway one second after checkout");
  eq(store.reconHistory(order.id).length, 0, "a too-early check must not consume an attempt");
});

test("reconciliation: repeated 'not paid yet' does not escalate to a human", async () => {
  simulator().clearFaults();
  const m = makeMandate();
  const store = new OrderStore();
  const { order } = store.create({ mandate: m, lines: [{ productId: "desk-mat-xl", qty: 1 }], idempotencyKey: "recon-patience" });
  await store.initiatePayment(order.id);

  // Backdate the order past the grace period but well inside the payment window.
  db()
    .prepare(`UPDATE orders SET createdAt = ? WHERE id = ?`)
    .run(new Date(Date.now() - 120_000).toISOString(), order.id);

  for (let i = 0; i < 6; i++) await store.reconcile(order.id, { reason: "test" });

  const final = store.byId(order.id)!;
  assert(
    final.status !== "needs_reconciliation",
    "a slow buyer must not be escalated as if the gateway were broken",
  );
  assert(store.reconHistory(order.id).length >= 6, "polls should still be recorded for observability");
});

test("reconciliation: a captured amount that does not match is held, not auto-completed", async () => {
  simulator().clearFaults();
  const m = makeMandate();
  const store = new OrderStore();
  const { order } = store.create({ mandate: m, lines: [{ productId: "footrest-ergo", qty: 1 }], idempotencyKey: "recon-mismatch" });
  await store.initiatePayment(order.id);
  ageOrder(order.id);
  const rzp = store.byId(order.id)!.razorpayOrderId!;

  // Pay it, then corrupt the amount at the gateway to simulate a short payment.
  simulator().setFaults({ dropNextWebhook: true });
  const payment = await simulator().completePayment(rzp);
  simulator().webhookOutbox.length = 0;
  payment.amount = M.paise(1);

  const r = await store.reconcile(order.id, { reason: "test" });
  eq(r.status, "amount_mismatch");
  eq(store.byId(order.id)!.status, "needs_reconciliation", "must not silently mark a short payment as paid");
});

test("reconciliation: a failed payment releases stock back to the catalog", async () => {
  simulator().clearFaults();
  const catalog = new CatalogRepository();
  const before = catalog.byId("desk-mat-xl")!.stock;
  const m = makeMandate();
  const store = new OrderStore();
  const { order } = store.create({ mandate: m, lines: [{ productId: "desk-mat-xl", qty: 3 }], idempotencyKey: "recon-fail" });
  eq(catalog.byId("desk-mat-xl")!.stock, before - 3);

  await store.initiatePayment(order.id);
  ageOrder(order.id);
  simulator().setFaults({ failPayment: true });
  await simulator().completePayment(store.byId(order.id)!.razorpayOrderId!);
  simulator().clearFaults();

  const r = await store.reconcile(order.id, { reason: "test" });
  eq(r.status, "payment_failed");
  eq(catalog.byId("desk-mat-xl")!.stock, before, "stock must return after a failed payment");
});

/* ---------- ledger ---------- */

test("ledger: canonical JSON is key-order independent", () => {
  eq(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});

test("ledger: undefined-valued keys survive serialisation (regression)", () => {
  // This is the bug that broke the chain: hashing an object with an
  // `undefined` value, then re-hashing it after a JSON round-trip.
  const withUndefined = { a: 1, b: undefined, c: 3 };
  const normalised = normalizePayload(withUndefined);
  eq(canonical(normalised), canonical(JSON.parse(JSON.stringify(withUndefined))));
});

test("ledger: append then verify reports an intact chain", () => {
  const l = ledger();
  const before = l.verify();
  assert(before.ok, `chain should start intact: ${before.reason}`);
  l.append({ action: "test.append", actor: { kind: "system", component: "tests" }, payload: { n: 1 } });
  const after = l.verify();
  assert(after.ok, `chain should still be intact: ${after.reason}`);
  assert(after.entries === before.entries + 1, "one entry should have been added");
});

test("ledger: tampering with a payload is detected", () => {
  const l = ledger();
  l.append({ action: "test.tamper", actor: { kind: "system", component: "tests" }, payload: { amount: 100 } });
  const row = db().prepare(`SELECT seq, payload FROM ledger WHERE action = 'test.tamper' ORDER BY seq DESC LIMIT 1`).get() as {
    seq: number;
    payload: string;
  };
  const tampered = JSON.parse(row.payload) as Record<string, unknown>;
  tampered.amount = 999999;
  db().prepare(`UPDATE ledger SET payload = ? WHERE seq = ?`).run(JSON.stringify(tampered), row.seq);

  const v = l.verify();
  eq(v.ok, false, "tampering must be detected");
  eq(v.brokenAtSeq, row.seq, "the tampered entry should be identified");
  assert(/does not match its recorded hash/.test(v.reason ?? ""), `unexpected reason: ${v.reason}`);
});

test("ledger: a deleted entry breaks the chain for everything after it", () => {
  const l = ledger();
  // Re-seal the tampered entry so we start from a good chain again.
  const row = db().prepare(`SELECT * FROM ledger ORDER BY seq DESC LIMIT 1`).get() as Record<string, unknown>;
  const entry = JSON.parse(String(row.payload)) as Record<string, unknown>;
  entry.amount = 100;
  const fixed = computeHash({
    prevHash: String(row.prevHash),
    ts: String(row.ts),
    action: String(row.action),
    actor: JSON.parse(String(row.actor)),
    mandateId: row.mandateId == null ? null : String(row.mandateId),
    runId: row.runId == null ? null : String(row.runId),
    orderId: row.orderId == null ? null : String(row.orderId),
    payload: entry,
  });
  db().prepare(`UPDATE ledger SET payload = ?, hash = ? WHERE seq = ?`).run(JSON.stringify(entry), fixed, row.seq);
  assert(l.verify().ok, "chain should be repaired for the purposes of this test");

  l.append({ action: "test.after", actor: { kind: "system", component: "tests" }, payload: {} });
  const last = db().prepare(`SELECT seq FROM ledger ORDER BY seq DESC LIMIT 1`).get() as { seq: number };
  db().prepare(`DELETE FROM ledger WHERE seq = ?`).run(last.seq - 1);

  const v = l.verify();
  eq(v.ok, false, "deleting a middle entry must be detected");
  assert(/claims prevHash/.test(v.reason ?? ""), `unexpected reason: ${v.reason}`);
});

/* ---------- agent ---------- */

test("agent: a request beyond the cap is denied, not fulfilled", async () => {
  const m = makeMandate({ perTxnCap: M.paise(5000), totalCap: M.paise(5000), approvalAbove: M.paise(100000) });
  const run = await new BuyerAgent().run({ mandate: m, request: "3 executive leather chairs", acceptOffers: false });
  eq(run.run.outcome, "denied");
});

test("agent: a settled order commits spend against the mandate's total cap", async () => {
  simulator().clearFaults();
  const m = makeMandate({ perTxnCap: M.paise(50000), totalCap: M.paise(50000), approvalAbove: M.paise(50000) });
  const store = new OrderStore();
  const run = await new BuyerAgent().run({ mandate: m, request: "1 ergonomic footrest", acceptOffers: false });
  const order = store.byId(run.run.orderId!)!;
  await store.initiatePayment(order.id);
  ageOrder(order.id);
  await simulator().completePayment(order.razorpayOrderId!);
  for (const w of simulator().webhookOutbox) {
    // Deliver it the way the real webhook path would.
    if (w.event === "payment.captured") {
      await store.reconcile(order.id, { reason: "test" });
    }
  }
  simulator().webhookOutbox.length = 0;
  const after = new MandateStore().byId(m.id)!;
  assert(M.toInt(after.spent) > 0, "spend should be committed against the total cap");
});

/* ================================================================== */

async function main() {
  console.log("\n\x1b[1mVyapaar — test suite\x1b[0m");
  console.log(`db: ${process.env.DB_PATH ?? "default"}\n`);
  resetDatabase();
  seedCatalog();

  for (const t of queue) await t();

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
  if (failed) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("");
}

main();
