import { randomUUID } from "node:crypto";
import { db, ledger } from "../db";
import * as M from "../domain/money";
import type { Mandate, Order, OrderEvent, OrderLine, OrderStatus } from "../domain/types";
import { evaluatePurchase, type MerchantPolicy } from "../governance/policy";
import { CatalogRepository } from "../catalog/repository";
import { DEFAULT_MERCHANT_POLICY, priceLines, shippingFor, subtotalOf } from "../merchant/offers";
import { GatewayError, gateway } from "./index";

/**
 * Order lifecycle, and the two things that make it safe.
 *
 * IDEMPOTENCY: an idempotency key is required on every order creation and is
 * enforced by a UNIQUE constraint at the database level, not by an
 * application-level "have we seen this?" check that races. A client that
 * retries after a timeout gets the original order back, not a second charge.
 *
 * RECONCILIATION: a payment can succeed at the gateway while its webhook is
 * lost in transit. The order then sits in payment_pending forever while the
 * merchant has already been paid. This is the failure we handle gracefully: a
 * bounded reconciliation loop asks the gateway directly, treats the gateway as
 * the source of truth, and resolves the order deterministically.
 */

/**
 * How many consecutive gateway errors we tolerate before escalating to a human.
 *
 * This counts FAILURES TO REACH THE GATEWAY, not total polls. Counting every
 * poll would mean a buyer who takes their time at checkout burns the whole
 * budget and gets escalated as if something were broken, when in fact nothing
 * was. "We cannot tell whether money moved" is the emergency; "no money has
 * moved yet" is just Tuesday.
 */
export const MAX_RECON_ATTEMPTS = 5;
/** An unpaid order older than this is abandoned and its stock released. */
export const PAYMENT_WINDOW_MS = 15 * 60 * 1000;
/**
 * Grace period after payment initiation. Asking the gateway one second after
 * the buyer is handed the checkout is guaranteed to return "not yet", so we
 * don't ask, and we don't record it as an attempt either.
 */
export const PAYMENT_GRACE_MS = 45 * 1000;

export interface CreateOrderInput {
  mandate: Mandate;
  lines: Array<{ productId: string; qty: number }>;
  idempotencyKey: string;
  runId?: string;
  /** Discount already agreed, from an accepted offer. */
  discount?: M.Paise;
  policy?: MerchantPolicy;
}

export interface CreateOrderResult {
  order: Order;
  /** True when this call was a replay of a key we already served. */
  replayed: boolean;
  verdict: ReturnType<typeof evaluatePurchase>;
}

export class OrderStore {
  private catalog = new CatalogRepository();

  create(input: CreateOrderInput): CreateOrderResult {
    const actor = input.runId ? { kind: "agent" as const, runId: input.runId } : { kind: "system" as const, component: "order-api" };

    // --- 1. Idempotency: a replay returns the original, never a second charge.
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      ledger().append({
        action: "order.create.replayed",
        actor,
        mandateId: input.mandate.id,
        orderId: existing.id,
        payload: {
          idempotencyKey: input.idempotencyKey,
          existingStatus: existing.status,
          note: "Duplicate create suppressed. No new charge was created.",
        },
      });
      return {
        order: existing,
        replayed: true,
        verdict: {
          decision: "ALLOW",
          reasons: [{ code: "IDEMPOTENT_REPLAY", message: "Returned the original order for this idempotency key." }],
          mandateId: input.mandate.id,
          evaluatedAt: new Date().toISOString(),
        },
      };
    }

    // --- 2. Price deterministically.
    const priced = priceLines(input.lines, this.catalog);
    const subtotal = subtotalOf(priced);
    const discount = input.discount ?? M.paise(0);
    const shipping = shippingFor(M.sub(subtotal, discount));
    const total = M.add(M.sub(subtotal, discount), shipping);

    const orderLines: OrderLine[] = priced.map((l) => ({
      productId: l.productId,
      title: l.product.title,
      qty: l.qty,
      unitPrice: l.unitPrice,
      discount: M.paise(0),
    }));

    const orderId = `ord_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();

    // --- 3. Gate it. Nothing beyond this point may move money.
    const verdict = evaluatePurchase(input.mandate, {
      total,
      categories: [...new Set(priced.map((l) => l.product.category))],
      maxLineQty: Math.max(...input.lines.map((l) => l.qty)),
    });

    ledger().append({
      action: "policy.evaluate",
      actor,
      mandateId: input.mandate.id,
      orderId,
      payload: {
        decision: verdict.decision,
        reasons: verdict.reasons,
        total: M.toInt(total),
        subtotal: M.toInt(subtotal),
        discount: M.toInt(discount),
        shipping: M.toInt(shipping),
      },
    });

    // --- 4. Reserve stock only after the gate, so denials never hold inventory.
    if (verdict.decision !== "DENY") {
      const reserved: Array<{ productId: string; qty: number }> = [];
      let ok = true;
      for (const line of input.lines) {
        if (this.catalog.reserve(line.productId, line.qty)) {
          reserved.push(line);
          this.recordReservation(orderId, line.productId, line.qty);
        } else {
          ok = false;
          break;
        }
      }
      if (!ok) {
        for (const r of reserved) this.catalog.release(r.productId, r.qty);
        this.releaseReservations(orderId);
        const order = this.persist({
          id: orderId,
          mandateId: input.mandate.id,
          idempotencyKey: input.idempotencyKey,
          lines: orderLines,
          subtotal,
          discount,
          shipping,
          total,
          status: "failed",
          createdAt: now,
          updatedAt: now,
          history: [{ at: now, from: null, to: "failed", note: "Insufficient stock at reservation time." }],
        });
        ledger().append({
          action: "order.failed",
          actor,
          mandateId: input.mandate.id,
          orderId,
          payload: { reason: "INSUFFICIENT_STOCK", requested: input.lines },
        });
        return {
          order,
          replayed: false,
          verdict: {
            decision: "DENY",
            reasons: [{ code: "INSUFFICIENT_STOCK", message: "Stock could not be reserved for the requested lines." }],
            mandateId: input.mandate.id,
            evaluatedAt: now,
          },
        };
      }
    }

    // --- 5. Branch on the verdict.
    let status: OrderStatus;
    let note: string;
    if (verdict.decision === "DENY") {
      status = "failed";
      note = `Denied by policy: ${verdict.reasons.map((r) => r.code).join(", ")}`;
    } else if (verdict.decision === "REQUIRE_APPROVAL") {
      status = "awaiting_approval";
      note = "Held for human approval: amount exceeds the mandate's auto-approve threshold.";
    } else {
      status = "draft";
      note = "Cleared policy; awaiting payment initiation.";
    }

    const order = this.persist({
      id: orderId,
      mandateId: input.mandate.id,
      idempotencyKey: input.idempotencyKey,
      lines: orderLines,
      subtotal,
      discount,
      shipping,
      total,
      status,
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, from: null, to: status, note }],
    });

    ledger().append({
      action: verdict.decision === "DENY" ? "order.denied" : verdict.decision === "REQUIRE_APPROVAL" ? "order.held_for_approval" : "order.created",
      actor,
      mandateId: input.mandate.id,
      orderId,
      payload: { status, total: M.toInt(total), lines: orderLines, note },
    });

    if (verdict.decision === "DENY") this.releaseReservations(orderId);

    return { order, replayed: false, verdict };
  }

  /**
   * Move a cleared order to payment_pending by creating a Razorpay order.
   * Retries are safe: the receipt is derived from the internal order id, so
   * Razorpay returns the same gateway order rather than a new one.
   */
  async initiatePayment(orderId: string, runId?: string): Promise<Order> {
    const order = this.byId(orderId);
    if (!order) throw new Error(`No such order: ${orderId}`);

    if (order.status === "paid") return order;
    if (order.status === "payment_pending" && order.razorpayOrderId) return order;
    if (order.status === "awaiting_approval") {
      throw new Error("Order is awaiting human approval and cannot be paid yet.");
    }
    if (order.status === "failed" || order.status === "abandoned") {
      throw new Error(`Order is ${order.status} and cannot be paid.`);
    }

    const actor = runId ? { kind: "agent" as const, runId } : { kind: "system" as const, component: "order-api" };

    try {
      const gwOrder = await gateway().createOrder({
        amount: order.total,
        receipt: order.id,
        notes: { mandateId: order.mandateId, internalOrderId: order.id },
      });

      this.updateStatus(order.id, "payment_pending", `Razorpay order ${gwOrder.id} created for ${M.format(order.total)}.`);
      db().prepare(`UPDATE orders SET razorpayOrderId = ? WHERE id = ?`).run(gwOrder.id, order.id);

      ledger().append({
        action: "payment.initiated",
        actor,
        mandateId: order.mandateId,
        orderId: order.id,
        payload: {
          gateway: gateway().mode,
          razorpayOrderId: gwOrder.id,
          amount: M.toInt(order.total),
          currency: "INR",
        },
      });

      return this.byId(order.id)!;
    } catch (err) {
      const ge = err instanceof GatewayError ? err : null;
      // A timeout on create is ambiguous: the order may or may not exist at the
      // gateway. We do NOT retry blindly — that is how you get two orders. We
      // record the ambiguity and let reconciliation resolve it from the gateway.
      this.updateStatus(order.id, "needs_reconciliation", `Payment initiation failed: ${ge?.code ?? "UNKNOWN"}`);
      ledger().append({
        action: "payment.initiation_failed",
        actor,
        mandateId: order.mandateId,
        orderId: order.id,
        payload: {
          code: ge?.code ?? "UNKNOWN",
          retryable: ge?.retryable ?? false,
          message: (err as Error).message,
          decision: "Deferred to reconciliation rather than retried, to avoid duplicate orders.",
        },
      });
      throw err;
    }
  }

  /**
   * Reconciliation. Treats the gateway as the source of truth and our own row
   * as a possibly-stale cache. Bounded: after MAX_RECON_ATTEMPTS it escalates
   * to a human instead of looping forever.
   */
  async reconcile(orderId: string, opts: { actor?: string; reason?: string } = {}): Promise<ReconResult> {
    const order = this.byId(orderId);
    if (!order) return { status: "not_found", orderId, attempt: 0, detail: "No such order." };
    if (!order.razorpayOrderId) {
      return { status: "no_gateway_order", orderId, attempt: 0, detail: "No gateway order exists yet; nothing to reconcile." };
    }
    if (order.status === "paid" || order.status === "refunded" || order.status === "abandoned") {
      return { status: "already_final", orderId, attempt: 0, detail: `Order is already ${order.status}.` };
    }

    const age = Date.now() - new Date(order.createdAt).getTime();

    // Too soon to ask. Not an error, and not an attempt — just patience.
    if (order.status === "payment_pending" && age < PAYMENT_GRACE_MS) {
      return {
        status: "too_early",
        orderId,
        attempt: 0,
        detail: `Order is ${Math.round(age / 1000)}s old; waiting out the ${PAYMENT_GRACE_MS / 1000}s grace period before asking the gateway.`,
      };
    }

    const attempt = this.reconAttemptCount(orderId) + 1;
    const gatewayErrors = this.reconAttemptCountByOutcome(orderId, "gateway_error");

    if (gatewayErrors >= MAX_RECON_ATTEMPTS) {
      this.updateStatus(orderId, "needs_reconciliation", `Reconciliation exhausted after ${MAX_RECON_ATTEMPTS} attempts; escalated to a human.`);
      ledger().append({
        action: "reconciliation.exhausted",
        actor: { kind: "system", component: "reconciler" },
        mandateId: order.mandateId,
        orderId,
        payload: {
          attempts: attempt - 1,
          decision: "Escalated to human review. The system refuses to guess whether money moved.",
          trigger: opts.reason ?? opts.actor ?? "manual",
        },
      });
      return { status: "escalated", orderId, attempt, detail: "Escalated for human review." };
    }

    let captured: { id: string; amount: M.Paise } | null = null;
    let sawFailure = false;

    try {
      const payments = await gateway().fetchPaymentsForOrder(order.razorpayOrderId);
      const hit = payments.find((p) => p.status === "captured");
      if (hit) captured = { id: hit.id, amount: hit.amount };
      sawFailure = payments.some((p) => p.status === "failed") && !hit;
    } catch (err) {
      const ge = err instanceof GatewayError ? err : null;
      this.recordReconAttempt(orderId, attempt, "gateway_error", (err as Error).message);
      ledger().append({
        action: "reconciliation.attempt_failed",
        actor: { kind: "system", component: "reconciler" },
        mandateId: order.mandateId,
        orderId,
        payload: { attempt, code: ge?.code ?? "UNKNOWN", message: (err as Error).message, willRetry: attempt < MAX_RECON_ATTEMPTS },
      });
      return { status: "retry_scheduled", orderId, attempt, detail: `Gateway error: ${(err as Error).message}` };
    }

    // --- The money moved but the webhook never arrived. Recover.
    if (captured) {
      // A captured amount that does not match is NOT auto-resolved. Silently
      // marking a short payment as paid is how reconciliation bugs become
      // revenue leaks.
      if (M.toInt(captured.amount) !== M.toInt(order.total)) {
        this.recordReconAttempt(orderId, attempt, "amount_mismatch", `captured=${captured.amount} expected=${order.total}`);
        this.updateStatus(orderId, "needs_reconciliation", `Captured ${M.format(captured.amount)} but expected ${M.format(order.total)}.`);
        ledger().append({
          action: "reconciliation.amount_mismatch",
          actor: { kind: "system", component: "reconciler" },
          mandateId: order.mandateId,
          orderId,
          payload: {
            captured: M.toInt(captured.amount),
            expected: M.toInt(order.total),
            paymentId: captured.id,
            decision: "Held for human review. Not auto-completed.",
          },
        });
        return { status: "amount_mismatch", orderId, attempt, detail: `Captured ${M.format(captured.amount)}, expected ${M.format(order.total)}.` };
      }

      this.markPaid(order, captured.id, {
        via: "reconciliation",
        note: `Webhook was never received; recovered by polling the gateway on attempt ${attempt}.`,
      });
      this.recordReconAttempt(orderId, attempt, "recovered", `paymentId=${captured.id}`);
      return { status: "recovered", orderId, attempt, detail: `Recovered payment ${captured.id} from the gateway.` };
    }

    if (sawFailure) {
      this.recordReconAttempt(orderId, attempt, "payment_failed", "Gateway reported a failed payment.");
      this.updateStatus(orderId, "failed", "Gateway reported the payment as failed.");
      this.releaseReservations(orderId);
      ledger().append({
        action: "payment.failed",
        actor: { kind: "system", component: "reconciler" },
        mandateId: order.mandateId,
        orderId,
        payload: { attempt, decision: "Order failed; stock released." },
      });
      return { status: "payment_failed", orderId, attempt, detail: "Gateway reported a failed payment." };
    }

    // --- Genuinely still unpaid. Abandon once the payment window closes.
    if (age > PAYMENT_WINDOW_MS) {
      this.recordReconAttempt(orderId, attempt, "abandoned", `No payment after ${Math.round(age / 60000)} minutes.`);
      this.updateStatus(orderId, "abandoned", "Payment window elapsed without a captured payment.");
      this.releaseReservations(orderId);
      ledger().append({
        action: "order.abandoned",
        actor: { kind: "system", component: "reconciler" },
        mandateId: order.mandateId,
        orderId,
        payload: { ageMs: age, decision: "Stock released back to the catalog." },
      });
      return { status: "abandoned", orderId, attempt, detail: "Abandoned; stock released." };
    }

    this.recordReconAttempt(orderId, attempt, "still_pending", "No captured payment yet.");
    return { status: "still_pending", orderId, attempt, detail: "Payment not yet captured." };
  }

  /** Called by the webhook handler, or by reconciliation. Idempotent. */
  markPaid(order: Order, paymentId: string, meta: { via: string; note?: string }): Order {
    const already = this.byId(order.id);
    if (already && already.status === "paid" && already.razorpayPaymentId === paymentId) return already;

    db().prepare(`UPDATE orders SET razorpayPaymentId = ?, updatedAt = ? WHERE id = ?`).run(
      paymentId,
      new Date().toISOString(),
      order.id,
    );
    this.updateStatus(order.id, "paid", `Payment ${paymentId} captured (${meta.via}).`);

    // Commit spend against the mandate so the total cap is actually enforced
    // across the mandate's lifetime, not just per transaction.
    db().prepare(`UPDATE mandates SET spent = spent + ? WHERE id = ?`).run(M.toInt(order.total), order.mandateId);

    ledger().append({
      action: "payment.captured",
      actor: { kind: "system", component: meta.via },
      mandateId: order.mandateId,
      orderId: order.id,
      payload: {
        paymentId,
        amount: M.toInt(order.total),
        via: meta.via,
        note: meta.note ?? null,
        mandateSpendCommitted: M.toInt(order.total),
      },
    });

    return this.byId(order.id)!;
  }

  approve(orderId: string, by: string, decision: "approved" | "rejected", note?: string): Order {
    const order = this.byId(orderId);
    if (!order) throw new Error(`No such order: ${orderId}`);
    if (order.status !== "awaiting_approval") throw new Error(`Order is ${order.status}, not awaiting approval.`);

    db()
      .prepare(`UPDATE orders SET approval = ?, updatedAt = ? WHERE id = ?`)
      .run(JSON.stringify({ by, at: new Date().toISOString(), decision, note }), new Date().toISOString(), orderId);

    if (decision === "approved") {
      this.updateStatus(orderId, "draft", `Approved by ${by}. Order cleared to initiate payment.`);
    } else {
      this.updateStatus(orderId, "failed", `Rejected by ${by}.`);
      this.releaseReservations(orderId);
    }

    ledger().append({
      action: decision === "approved" ? "approval.granted" : "approval.rejected",
      actor: { kind: "human", id: by },
      mandateId: order.mandateId,
      orderId,
      payload: { by, decision, note: note ?? null, amount: M.toInt(order.total) },
    });

    return this.byId(orderId)!;
  }

  /* ---------------------------------------------------------------- *
   * Persistence helpers
   * ---------------------------------------------------------------- */

  byId(id: string): Order | undefined {
    const row = db().prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToOrder(row) : undefined;
  }

  findByIdempotencyKey(key: string): Order | undefined {
    const row = db().prepare(`SELECT * FROM orders WHERE idempotencyKey = ?`).get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToOrder(row) : undefined;
  }

  byRazorpayOrderId(rzpId: string): Order | undefined {
    const row = db().prepare(`SELECT * FROM orders WHERE razorpayOrderId = ?`).get(rzpId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToOrder(row) : undefined;
  }

  list(filter: { status?: OrderStatus; mandateId?: string; tail?: number } = {}): Order[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.status) {
      clauses.push("status = @status");
      params.status = filter.status;
    }
    if (filter.mandateId) {
      clauses.push("mandateId = @mandateId");
      params.mandateId = filter.mandateId;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.tail ? `LIMIT ${Number(filter.tail)}` : "";
    const rows = db().prepare(`SELECT * FROM orders ${where} ORDER BY createdAt DESC ${limit}`).all(params) as Array<
      Record<string, unknown>
    >;
    return rows.map(rowToOrder);
  }

  private persist(order: Order): Order {
    try {
      db()
        .prepare(
          `INSERT INTO orders (id, mandateId, idempotencyKey, lines, subtotal, discount, shipping, total, status,
                               razorpayOrderId, razorpayPaymentId, approval, createdAt, updatedAt, history)
           VALUES (@id, @mandateId, @idempotencyKey, @lines, @subtotal, @discount, @shipping, @total, @status,
                   @razorpayOrderId, @razorpayPaymentId, @approval, @createdAt, @updatedAt, @history)`,
        )
        .run({
          id: order.id,
          mandateId: order.mandateId,
          idempotencyKey: order.idempotencyKey,
          lines: JSON.stringify(order.lines),
          subtotal: M.toInt(order.subtotal),
          discount: M.toInt(order.discount),
          shipping: M.toInt(order.shipping),
          total: M.toInt(order.total),
          status: order.status,
          razorpayOrderId: order.razorpayOrderId ?? null,
          razorpayPaymentId: order.razorpayPaymentId ?? null,
          approval: order.approval ? JSON.stringify(order.approval) : null,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          history: JSON.stringify(order.history),
        });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("UNIQUE constraint failed: orders.idempotencyKey")) {
        // A concurrent writer beat us to it. Serve theirs — that is the point.
        const raced = this.findByIdempotencyKey(order.idempotencyKey);
        if (raced) return raced;
      }
      throw err;
    }
    return this.byId(order.id)!;
  }

  private updateStatus(orderId: string, to: OrderStatus, note: string): void {
    const now = new Date().toISOString();
    const row = db().prepare(`SELECT status, history FROM orders WHERE id = ?`).get(orderId) as
      | { status: OrderStatus; history: string }
      | undefined;
    if (!row) throw new Error(`No such order: ${orderId}`);
    const history = JSON.parse(row.history) as OrderEvent[];
    history.push({ at: now, from: row.status, to, note });
    db().prepare(`UPDATE orders SET status = ?, history = ?, updatedAt = ? WHERE id = ?`).run(
      to,
      JSON.stringify(history),
      now,
      orderId,
    );
  }

  private recordReservation(orderId: string, productId: string, qty: number): void {
    db()
      .prepare(`INSERT INTO reservations (id, orderId, productId, qty, createdAt) VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), orderId, productId, qty, new Date().toISOString());
  }

  private releaseReservations(orderId: string): void {
    const rows = db()
      .prepare(`SELECT * FROM reservations WHERE orderId = ? AND releasedAt IS NULL`)
      .all(orderId) as Array<{ productId: string; qty: number }>;
    for (const r of rows) this.catalog.release(r.productId, r.qty);
    db().prepare(`UPDATE reservations SET releasedAt = ? WHERE orderId = ?`).run(new Date().toISOString(), orderId);
  }

  private reconAttemptCount(orderId: string): number {
    const row = db()
      .prepare(`SELECT COUNT(*) AS n FROM reconciliation_attempts WHERE orderId = ?`)
      .get(orderId) as { n: number };
    return row.n;
  }

  private reconAttemptCountByOutcome(orderId: string, outcome: string): number {
    const row = db()
      .prepare(`SELECT COUNT(*) AS n FROM reconciliation_attempts WHERE orderId = ? AND outcome = ?`)
      .get(orderId, outcome) as { n: number };
    return row.n;
  }

  private recordReconAttempt(orderId: string, attempt: number, outcome: string, detail: string): void {
    db()
      .prepare(
        `INSERT INTO reconciliation_attempts (orderId, attempt, outcome, detail, at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(orderId, attempt, outcome, detail, new Date().toISOString());
  }

  reconHistory(orderId: string): Array<{ attempt: number; outcome: string; detail: string; at: string }> {
    return db()
      .prepare(`SELECT attempt, outcome, detail, at FROM reconciliation_attempts WHERE orderId = ? ORDER BY attempt ASC`)
      .all(orderId) as Array<{ attempt: number; outcome: string; detail: string; at: string }>;
  }
}

export type ReconResult =
  | { status: "recovered" | "still_pending" | "retry_scheduled" | "payment_failed" | "abandoned" | "amount_mismatch" | "escalated" | "already_final" | "no_gateway_order" | "not_found" | "too_early"; orderId: string; attempt: number; detail: string };

export function rowToOrder(row: Record<string, unknown>): Order {
  return {
    id: String(row.id),
    mandateId: String(row.mandateId),
    idempotencyKey: String(row.idempotencyKey),
    lines: JSON.parse(String(row.lines)) as OrderLine[],
    subtotal: Number(row.subtotal) as M.Paise,
    discount: Number(row.discount) as M.Paise,
    shipping: Number(row.shipping) as M.Paise,
    total: Number(row.total) as M.Paise,
    status: row.status as OrderStatus,
    razorpayOrderId: row.razorpayOrderId == null ? undefined : String(row.razorpayOrderId),
    razorpayPaymentId: row.razorpayPaymentId == null ? undefined : String(row.razorpayPaymentId),
    approval: row.approval == null ? undefined : (JSON.parse(String(row.approval)) as Order["approval"]),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    history: JSON.parse(String(row.history)) as OrderEvent[],
  };
}
