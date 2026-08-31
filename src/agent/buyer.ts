import { createHash, randomUUID } from "node:crypto";
import { db, ledger } from "../db";
import * as M from "../domain/money";
import type { AgentRun, Mandate, Product, PurchaseIntent, RunStep } from "../domain/types";
import { CatalogRepository } from "../catalog/repository";
import { generateOffers, subtotalOf, shippingFor, type CartLine } from "../merchant/offers";
import { OrderStore } from "../commerce/orders";
import { evaluatePurchase } from "../governance/policy";
import { parseIntent } from "./intent";

/**
 * The AI buyer.
 *
 * It is autonomous in the sense that matters — it plans, searches, weighs
 * offers and pays without a human in the loop — and it is not autonomous in the
 * sense that matters more: it cannot exceed the mandate, cannot approve its own
 * spend above threshold, and cannot quietly retry into a double charge.
 *
 * Every step emits a RunStep (for the dashboard) and a ledger entry (for
 * audit). The two are different audiences for the same truth.
 */

const CONFIDENCE_FLOOR = 0.4;

export interface RunOptions {
  mandate: Mandate;
  request: string;
  /** Stop before creating a gateway order. Used for quotes and dry runs. */
  dryRun?: boolean;
  /** Whether the agent may accept merchant offers. */
  acceptOffers?: boolean;
}

export interface RunResult {
  run: AgentRun;
  /** Present on a dry run: what would have been charged. */
  quote?: {
    lines: Array<{ productId: string; title: string; qty: number; unitPrice: number; lineTotal: number }>;
    subtotal: number;
    discount: number;
    shipping: number;
    total: number;
    decision: string;
    reasons: string[];
  };
}

export class BuyerAgent {
  private catalog = new CatalogRepository();
  private orders = new OrderStore();

  async run(options: RunOptions): Promise<RunResult> {
    const runId = `run_${randomUUID().slice(0, 12)}`;
    const startedAt = new Date().toISOString();
    const steps: RunStep[] = [];
    let seq = 0;

    const step = (kind: RunStep["kind"], summary: string, detail?: Record<string, unknown>) => {
      const s: RunStep = { seq: seq++, kind, summary, detail, at: new Date().toISOString() };
      steps.push(s);
      this.persistRun({ id: runId, mandateId: options.mandate.id, intent: PLACEHOLDER, steps, outcome: "failed", startedAt });
      return s;
    };

    const actor = { kind: "agent" as const, runId };

    ledger().append({
      action: "run.started",
      actor,
      mandateId: options.mandate.id,
      runId,
      payload: {
        request: options.request,
        perTxnCap: M.toInt(options.mandate.perTxnCap),
        remainingAuthority: M.toInt(M.sub(options.mandate.totalCap, options.mandate.spent)),
        approvalAbove: M.toInt(options.mandate.approvalAbove),
      },
    });

    // ---------- 1. PLAN ----------
    const parsed = await parseIntent(options.request);
    const intent = parsed.intent;
    step("plan", `Parsed intent (${intent.source}, confidence ${intent.confidence.toFixed(2)})`, {
      terms: intent.terms,
      category: intent.category ?? null,
      maxUnitPrice: intent.maxUnitPrice ? M.format(intent.maxUnitPrice) : null,
      qty: intent.qty,
      attributeFilters: intent.attributeFilters,
      degradedFrom: parsed.degradedFrom ?? null,
      degradationReason: parsed.degradationReason ?? null,
    });

    ledger().append({
      action: "intent.parsed",
      actor,
      mandateId: options.mandate.id,
      runId,
      payload: {
        source: intent.source,
        confidence: intent.confidence,
        intent: { ...intent, maxUnitPrice: intent.maxUnitPrice ? M.toInt(intent.maxUnitPrice) : null },
        degradedFrom: parsed.degradedFrom ?? null,
      },
    });

    // A badly understood request is a reason to stop, not to guess. Spending
    // money on a confident misread is worse than asking.
    if (intent.confidence < CONFIDENCE_FLOOR) {
      step("plan", `Confidence ${intent.confidence.toFixed(2)} is below the floor ${CONFIDENCE_FLOOR}; stopping to ask rather than guess.`);
      ledger().append({
        action: "run.aborted_low_confidence",
        actor,
        mandateId: options.mandate.id,
        runId,
        payload: { confidence: intent.confidence, floor: CONFIDENCE_FLOOR, request: options.request },
      });
      return {
        run: this.finishRun({ id: runId, mandateId: options.mandate.id, intent, steps, outcome: "failed", startedAt }),
      };
    }

    // ---------- 2. DISCOVER ----------
    let candidates = this.catalog.search({
      terms: intent.terms,
      category: intent.category,
      maxUnitPrice: intent.maxUnitPrice,
      maxShipsInDays: intent.maxShipsInDays,
      attributeFilters: intent.attributeFilters,
    });

    // Graceful degradation: relax the softest constraint first, and say so.
    const relaxations: string[] = [];
    if (candidates.length === 0 && intent.maxShipsInDays !== undefined) {
      relaxations.push("delivery window");
      candidates = this.catalog.search({
        terms: intent.terms,
        category: intent.category,
        maxUnitPrice: intent.maxUnitPrice,
        attributeFilters: intent.attributeFilters,
      });
    }
    if (candidates.length === 0 && Object.keys(intent.attributeFilters).length > 0) {
      relaxations.push("attribute filters");
      candidates = this.catalog.search({
        terms: intent.terms,
        category: intent.category,
        maxUnitPrice: intent.maxUnitPrice,
      });
    }
    if (candidates.length === 0 && intent.category) {
      relaxations.push("category");
      candidates = this.catalog.search({ terms: intent.terms, maxUnitPrice: intent.maxUnitPrice });
    }

    step("discover", `Found ${candidates.length} candidate(s)${relaxations.length ? ` after relaxing ${relaxations.join(", ")}` : ""}`, {
      relaxations,
      top: candidates.slice(0, 5).map((c) => ({ id: c.id, title: c.title, price: M.format(c.price), stock: c.stock, score: c.matchScore })),
    });

    if (candidates.length === 0) {
      ledger().append({
        action: "run.no_candidates",
        actor,
        mandateId: options.mandate.id,
        runId,
        payload: { intent, relaxations },
      });
      return {
        run: this.finishRun({ id: runId, mandateId: options.mandate.id, intent, steps, outcome: "failed", startedAt }),
      };
    }

    // ---------- 3. EVALUATE ----------
    const chosen = candidates[0];
    const qty = Math.min(intent.qty, chosen.stock, options.mandate.maxQtyPerLine);
    const cart: CartLine[] = [{ productId: chosen.id, qty }];

    step("evaluate", `Selected ${chosen.title} × ${qty} at ${M.format(chosen.price)} each`, {
      productId: chosen.id,
      qty,
      unitPrice: M.format(chosen.price),
      matchedOn: chosen.matchedOn,
      rejectedAlternatives: candidates.slice(1, 4).map((c) => ({ id: c.id, price: M.format(c.price), score: c.matchScore })),
      reason: `Highest match score (${chosen.matchScore}) within constraints.`,
    });

    // ---------- 4. OFFERS ----------
    let discount = M.paise(0);
    let acceptedOffers: Array<{ id: string; title: string; rationale: string; discount: string }> = [];

    if (options.acceptOffers !== false) {
      const { priced, subtotal, allowed, rejected } = generateOffers(cart, this.catalog);
      step("offer", `${allowed.length} offer(s) cleared merchant policy, ${rejected.length} rejected`, {
        allowed: allowed.map((o) => ({ title: o.offer.title, discount: M.format(o.offer.discount), rationale: o.offer.rationale })),
        rejected: rejected.map((o) => ({ title: o.offer.title, why: o.reasons })),
      });

      ledger().append({
        action: "offers.evaluated",
        actor,
        mandateId: options.mandate.id,
        runId,
        payload: {
          allowed: allowed.map((o) => ({ ruleId: o.offer.ruleId, discount: M.toInt(o.offer.discount), margin: M.toInt(o.offer.projectedMargin) })),
          rejected: rejected.map((o) => ({ ruleId: o.offer.ruleId, reasons: o.reasons })),
        },
      });

      // Accept an offer only if the resulting total still clears the mandate.
      // The growth half must never be able to buy its way past the buyer's cap.
      for (const candidate of allowed) {
        const trialCart = [...cart, ...candidate.offer.lines.map((l) => ({ productId: l.productId, qty: l.qty }))];
        const trialPriced = pricedOfTrial(this.catalog, trialCart);
        const trialSubtotal = subtotalOf(trialPriced);
        const trialDiscount = M.add(discount, candidate.offer.discount);
        const trialTotal = M.add(M.sub(trialSubtotal, trialDiscount), shippingFor(M.sub(trialSubtotal, trialDiscount)));

        const trialVerdict = evaluatePurchase(options.mandate, {
          total: trialTotal,
          categories: [...new Set(trialPriced.map((l) => l.product.category))],
          maxLineQty: Math.max(...trialCart.map((l) => l.qty)),
        });

        if (trialVerdict.decision !== "DENY") {
          cart.length = 0;
          cart.push(...trialCart);
          discount = trialDiscount;
          acceptedOffers.push({
            id: candidate.offer.id,
            title: candidate.offer.title,
            rationale: candidate.offer.rationale,
            discount: M.format(candidate.offer.discount),
          });
          step("offer", `Accepted "${candidate.offer.title}" — ${candidate.offer.rationale}`, {
            discount: M.format(candidate.offer.discount),
            newTotal: M.format(trialTotal),
            verdict: trialVerdict.decision,
          });
        } else {
          step("offer", `Rejected "${candidate.offer.title}" — it would breach the mandate`, {
            reasons: trialVerdict.reasons.map((r) => r.code),
          });
        }
      }
      void subtotal;
    }

    // ---------- 5. GATE ----------
    const pricedFinal = pricedOfTrial(this.catalog, cart);
    const subtotalFinal = subtotalOf(pricedFinal);
    const total = M.add(M.sub(subtotalFinal, discount), shippingFor(M.sub(subtotalFinal, discount)));

    const quote = {
      lines: pricedFinal.map((l) => ({
        productId: l.productId,
        title: l.product.title,
        qty: l.qty,
        unitPrice: M.toInt(l.unitPrice),
        lineTotal: M.toInt(l.lineTotal),
      })),
      subtotal: M.toInt(subtotalFinal),
      discount: M.toInt(discount),
      shipping: M.toInt(shippingFor(M.sub(subtotalFinal, discount))),
      total: M.toInt(total),
      decision: "PENDING",
      reasons: [] as string[],
    };

    if (options.dryRun) {
      const verdict = evaluatePurchase(options.mandate, {
        total,
        categories: [...new Set(pricedFinal.map((l) => l.product.category))],
        maxLineQty: Math.max(...cart.map((l) => l.qty)),
      });
      quote.decision = verdict.decision;
      quote.reasons = verdict.reasons.map((r) => `${r.code}: ${r.message}`);
      step("gate", `Dry run — verdict ${verdict.decision}`, { total: M.format(total), reasons: quote.reasons });
      return {
        run: this.finishRun({ id: runId, mandateId: options.mandate.id, intent, steps, outcome: "completed", startedAt }),
        quote,
      };
    }

    // Idempotency key is derived from the mandate and the exact cart, so a
    // retry of the same decision can never produce a second charge.
    const idempotencyKey = createHash("sha256")
      .update(`${options.mandate.id}|${JSON.stringify(cart.map((c) => [c.productId, c.qty]).sort())}|${M.toInt(discount)}|${runId}`)
      .digest("hex")
      .slice(0, 32);

    const created = this.orders.create({
      mandate: options.mandate,
      lines: cart,
      idempotencyKey,
      discount,
      runId,
    });

    step("gate", `Policy verdict: ${created.verdict.decision}`, {
      total: M.format(created.order.total),
      reasons: created.verdict.reasons.map((r) => `${r.code}: ${r.message}`),
      replayed: created.replayed,
    });

    quote.decision = created.verdict.decision;
    quote.reasons = created.verdict.reasons.map((r) => `${r.code}: ${r.message}`);

    if (created.verdict.decision === "DENY") {
      ledger().append({
        action: "run.denied",
        actor,
        mandateId: options.mandate.id,
        runId,
        orderId: created.order.id,
        payload: { reasons: created.verdict.reasons, total: M.toInt(created.order.total) },
      });
      return {
        run: this.finishRun({ id: runId, mandateId: options.mandate.id, intent, steps, outcome: "denied", orderId: created.order.id, startedAt }),
        quote,
      };
    }

    if (created.verdict.decision === "REQUIRE_APPROVAL") {
      step("gate", "Held for human approval. The agent will not spend above threshold on its own.", {
        total: M.format(created.order.total),
        approvalAbove: M.format(options.mandate.approvalAbove),
      });
      return {
        run: this.finishRun({ id: runId, mandateId: options.mandate.id, intent, steps, outcome: "awaiting_approval", orderId: created.order.id, startedAt }),
        quote,
      };
    }

    // ---------- 6. PAY ----------
    try {
      const paid = await this.orders.initiatePayment(created.order.id, runId);
      step("pay", `Payment initiated via ${"gateway"} — Razorpay order ${paid.razorpayOrderId}`, {
        orderId: paid.id,
        razorpayOrderId: paid.razorpayOrderId,
        amount: M.format(paid.total),
        status: paid.status,
      });
      return {
        run: this.finishRun({ id: runId, mandateId: options.mandate.id, intent, steps, outcome: "completed", orderId: paid.id, startedAt }),
        quote,
      };
    } catch (err) {
      step("recover", `Payment initiation failed: ${(err as Error).message}. Deferred to reconciliation instead of retrying blindly.`);
      return {
        run: this.finishRun({ id: runId, mandateId: options.mandate.id, intent, steps, outcome: "failed", orderId: created.order.id, startedAt }),
        quote,
      };
    }
  }

  /* ---------------------------------------------------------------- */

  private persistRun(run: AgentRun): void {
    db()
      .prepare(
        `INSERT INTO runs (id, mandateId, intent, steps, outcome, orderId, startedAt, finishedAt)
         VALUES (@id, @mandateId, @intent, @steps, @outcome, @orderId, @startedAt, @finishedAt)
         ON CONFLICT(id) DO UPDATE SET
           steps=excluded.steps, outcome=excluded.outcome, orderId=excluded.orderId`,
      )
      .run({
        id: run.id,
        mandateId: run.mandateId,
        intent: JSON.stringify(run.intent),
        steps: JSON.stringify(run.steps),
        outcome: run.outcome,
        orderId: run.orderId ?? null,
        startedAt: run.startedAt,
        finishedAt: null,
      });
  }

  private finishRun(run: Omit<AgentRun, "finishedAt">): AgentRun {
    const finished: AgentRun = { ...run, finishedAt: new Date().toISOString() };
    db()
      .prepare(`UPDATE runs SET steps = ?, outcome = ?, orderId = ?, finishedAt = ? WHERE id = ?`)
      .run(JSON.stringify(finished.steps), finished.outcome, finished.orderId ?? null, finished.finishedAt, finished.id);

    ledger().append({
      action: "run.finished",
      actor: { kind: "agent", runId: run.id },
      mandateId: run.mandateId,
      runId: run.id,
      orderId: run.orderId ?? null,
      payload: { outcome: finished.outcome, steps: finished.steps.length },
    });

    return finished;
  }

  listRuns(tail = 20): AgentRun[] {
    const rows = db().prepare(`SELECT * FROM runs ORDER BY startedAt DESC LIMIT ?`).all(tail) as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      id: String(r.id),
      mandateId: String(r.mandateId),
      intent: JSON.parse(String(r.intent)) as PurchaseIntent,
      steps: JSON.parse(String(r.steps)) as RunStep[],
      outcome: r.outcome as AgentRun["outcome"],
      orderId: r.orderId == null ? undefined : String(r.orderId),
      startedAt: String(r.startedAt),
      finishedAt: r.finishedAt == null ? undefined : String(r.finishedAt),
    }));
  }

  getRun(id: string): AgentRun | undefined {
    return this.listRuns(200).find((r) => r.id === id);
  }
}

function pricedOfTrial(catalog: CatalogRepository, cart: CartLine[]) {
  return cart.map((line) => {
    const product = catalog.byId(line.productId) as Product;
    return { ...line, product, unitPrice: product.price, lineTotal: M.mulQty(product.price, line.qty) };
  });
}

const PLACEHOLDER: PurchaseIntent = {
  terms: [],
  qty: 1,
  attributeFilters: {},
  raw: "",
  confidence: 0,
  source: "heuristic",
};
