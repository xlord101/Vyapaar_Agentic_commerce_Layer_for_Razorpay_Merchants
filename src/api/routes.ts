import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import * as M from "../domain/money";
import { config, modeSummary } from "../config";
import { db, ledger } from "../db";
import { CatalogRepository } from "../catalog/repository";
import { buildManifest, toFeedProduct, toLlmsTxt } from "../catalog/feed";
import { seedCatalog } from "../catalog/seed";
import { generateOffers, subtotalOf, shippingFor, priceLines, DEFAULT_MERCHANT_POLICY } from "../merchant/offers";
import { MandateStore } from "../governance/mandates";
import { evaluatePurchase } from "../governance/policy";
import { OrderStore } from "../commerce/orders";
import { gateway, simulator } from "../commerce";
import { BuyerAgent } from "../agent/buyer";
import { heuristicParse } from "../agent/intent";

export const router = Router();

const catalog = new CatalogRepository();
const mandates = new MandateStore();
const orders = new OrderStore();
const agent = new BuyerAgent();

function asyncH<T>(fn: (req: Request, res: Response) => Promise<T>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: Error) => {
      res.status(400).json({ error: err.message });
    });
  };
}

function requireMandateId(req: Request): string {
  const id = (req.body?.mandateId as string | undefined) ?? (req.query.mandateId as string | undefined);
  if (!id) throw new Error("mandateId is required.");
  return id;
}

/* ================================================================== *
 * Agent-facing discovery
 * ================================================================== */

router.get("/.well-known/agent-commerce.json", (_req, res) => {
  res.json(
    buildManifest({
      maxQtyPerLine: 5,
      mode: gateway().mode === "razorpay-test" ? "test" : "test",
    }),
  );
});

router.get("/api/v1/feed/products", (_req, res) => {
  const products = catalog.all();
  res.json({
    feed_version: "1.0",
    currency: "INR",
    count: products.length,
    products: products.map(toFeedProduct),
    updated_at: new Date().toISOString(),
  });
});

router.get("/llms.txt", (_req, res) => {
  res.type("text/plain").send(toLlmsTxt(catalog.all()));
});

/** What would the merchant offer for this cart? The growth half, exposed. */
router.post("/api/v1/feed/offers", (req, res) => {
  const lines = (req.body?.lines ?? []) as Array<{ productId: string; qty: number }>;
  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "lines must be a non-empty array of {productId, qty}." });
  }
  const { priced, subtotal, allowed, rejected } = generateOffers(lines, catalog);
  res.json({
    subtotal: M.toInt(subtotal),
    shipping: M.toInt(shippingFor(subtotal)),
    allowed: allowed.map((o) => ({ ...o.offer, discount: M.toInt(o.offer.discount), projectedMargin: M.toInt(o.offer.projectedMargin) })),
    rejected: rejected.map((o) => ({ offerId: o.offer.id, ruleId: o.offer.ruleId, title: o.offer.title, reasons: o.reasons })),
    lines: priced.map((l) => ({ productId: l.productId, qty: l.qty, unitPrice: M.toInt(l.unitPrice) })),
  });
});

/* ================================================================== *
 * Commerce
 * ================================================================== */

/** Price a cart and return the policy verdict without moving money. */
router.post("/api/v1/commerce/quote", (req, res) => {
  const mandateId = requireMandateId(req);
  const mandate = mandates.byId(mandateId);
  if (!mandate) return res.status(404).json({ error: `No such mandate: ${mandateId}` });

  const lines = (req.body?.lines ?? []) as Array<{ productId: string; qty: number }>;
  const discount = req.body?.discount != null ? M.paise(req.body.discount) : M.paise(0);

  const priced = priceLines(lines, catalog);
  const subtotal = subtotalOf(priced);
  const shipping = shippingFor(M.sub(subtotal, discount));
  const total = M.add(M.sub(subtotal, discount), shipping);

  const verdict = evaluatePurchase(mandate, {
    total,
    categories: [...new Set(priced.map((l) => l.product.category))],
    maxLineQty: Math.max(...lines.map((l) => l.qty)),
  });

  res.json({
    mandateId,
    lines: priced.map((l) => ({
      productId: l.productId,
      title: l.product.title,
      qty: l.qty,
      unitPrice: M.toInt(l.unitPrice),
      lineTotal: M.toInt(l.lineTotal),
    })),
    subtotal: M.toInt(subtotal),
    discount: M.toInt(discount),
    shipping: M.toInt(shipping),
    total: M.toInt(total),
    verdict: {
      decision: verdict.decision,
      reasons: verdict.reasons,
      evaluatedAt: verdict.evaluatedAt,
    },
    quote_valid_for_seconds: 900,
  });
});

/** Place an order. Requires an Idempotency-Key header. */
router.post("/api/v1/commerce/orders", (req, res) => {
  const mandateId = requireMandateId(req);
  const mandate = mandates.byId(mandateId);
  if (!mandate) return res.status(404).json({ error: `No such mandate: ${mandateId}` });

  const idem = req.header("Idempotency-Key");
  if (!idem) {
    return res.status(400).json({
      error: "Idempotency-Key header is required. Replays return the original order instead of charging twice.",
    });
  }

  const lines = (req.body?.lines ?? []) as Array<{ productId: string; qty: number }>;
  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "lines must be a non-empty array of {productId, qty}." });
  }

  const result = orders.create({
    mandate,
    lines,
    idempotencyKey: idem,
    discount: req.body?.discount != null ? M.paise(req.body.discount) : M.paise(0),
  });

  res.status(result.replayed ? 200 : 201).json({
    order: serialiseOrder(result.order),
    replayed: result.replayed,
    verdict: {
      decision: result.verdict.decision,
      reasons: result.verdict.reasons,
    },
  });
});

router.get("/api/v1/commerce/orders/:id", (req, res) => {
  const order = orders.byId(req.params.id);
  if (!order) return res.status(404).json({ error: "No such order." });
  res.json({
    order: serialiseOrder(order),
    reconciliation: orders.reconHistory(order.id),
  });
});

/* ================================================================== *
 * Mandates
 * ================================================================== */

router.post("/api/v1/mandates", (req, res) => {
  const b = req.body ?? {};
  if (!b.principal || !b.purpose) {
    return res.status(400).json({ error: "principal and purpose are required." });
  }
  const mandate = mandates.create({
    principal: String(b.principal),
    purpose: String(b.purpose),
    perTxnCap: M.paise(b.perTxnCap ?? 20000),
    totalCap: M.paise(b.totalCap ?? 60000),
    approvalAbove: M.paise(b.approvalAbove ?? 12000),
    categoryAllowlist: Array.isArray(b.categoryAllowlist) ? b.categoryAllowlist : [],
    maxQtyPerLine: Number(b.maxQtyPerLine ?? 5),
    validHours: Number(b.validHours ?? 72),
  });
  res.status(201).json({ mandate: serialiseMandate(mandate) });
});

router.get("/api/v1/mandates", (_req, res) => {
  res.json({ mandates: mandates.list().map(serialiseMandate) });
});

router.post("/api/v1/mandates/:id/revoke", (req, res) => {
  const by = (req.body?.by as string) ?? "principal";
  res.json({ mandate: serialiseMandate(mandates.revoke(req.params.id, by)) });
});

/* ================================================================== *
 * The agent
 * ================================================================== */

router.post(
  "/api/v1/agent/run",
  asyncH(async (req, res) => {
    const mandateId = requireMandateId(req);
    const mandate = mandates.byId(mandateId);
    if (!mandate) return res.status(404).json({ error: `No such mandate: ${mandateId}` });

    const request = req.body?.request as string | undefined;
    if (!request) return res.status(400).json({ error: "request is required." });

    const result = await agent.run({
      mandate,
      request,
      dryRun: Boolean(req.body?.dryRun),
      acceptOffers: req.body?.acceptOffers !== false,
    });

    res.json({ run: result.run, quote: result.quote });
  }),
);

router.get("/api/v1/runs", (_req, res) => {
  res.json({ runs: agent.listRuns(50) });
});

/** Parse-only endpoint: see what the agent understood, without acting. */
router.post("/api/v1/agent/parse", (req, res) => {
  const request = (req.body?.request as string | undefined) ?? "";
  const intent = heuristicParse(request);
  res.json({
    intent: { ...intent, maxUnitPrice: intent.maxUnitPrice ? M.toInt(intent.maxUnitPrice) : null },
    matches: catalog
      .search({
        terms: intent.terms,
        category: intent.category,
        maxUnitPrice: intent.maxUnitPrice,
        maxShipsInDays: intent.maxShipsInDays,
        attributeFilters: intent.attributeFilters,
      })
      .slice(0, 5)
      .map((p) => ({ id: p.id, title: p.title, price: M.toInt(p.price), score: p.matchScore, matchedOn: p.matchedOn })),
  });
});

/* ================================================================== *
 * Orders, approvals, reconciliation
 * ================================================================== */

router.get("/api/v1/orders", (req, res) => {
  const status = req.query.status as string | undefined;
  res.json({
    orders: orders
      .list({ status: status as never, tail: 100 })
      .map((o) => serialiseOrder(o)),
  });
});

router.post("/api/v1/orders/:id/approve", (req, res) => {
  const by = (req.body?.by as string) ?? "operator";
  const decision = req.body?.decision === "rejected" ? "rejected" : "approved";
  const order = orders.approve(req.params.id, by, decision, req.body?.note as string | undefined);
  res.json({ order: serialiseOrder(order) });
});

router.post(
  "/api/v1/orders/:id/pay",
  asyncH(async (req, res) => {
    const order = await orders.initiatePayment(req.params.id);
    res.json({ order: serialiseOrder(order) });
  }),
);

router.post(
  "/api/v1/orders/:id/reconcile",
  asyncH(async (req, res) => {
    const result = await orders.reconcile(req.params.id, { reason: "manual" });
    res.json({
      result,
      order: orders.byId(req.params.id) ? serialiseOrder(orders.byId(req.params.id)!) : null,
      history: orders.reconHistory(req.params.id),
    });
  }),
);

/* ================================================================== *
 * Audit
 * ================================================================== */

router.get("/api/v1/ledger", (req, res) => {
  const filter = {
    runId: req.query.runId as string | undefined,
    orderId: req.query.orderId as string | undefined,
    mandateId: req.query.mandateId as string | undefined,
    tail: req.query.tail ? Number(req.query.tail) : 200,
  };
  res.json({ entries: ledger().list(filter) });
});

router.get("/api/v1/ledger/verify", (_req, res) => {
  res.json(ledger().verify());
});

/* ================================================================== *
 * Simulator controls (demo only)
 * ================================================================== */

router.post("/api/v1/simulator/faults", (req, res) => {
  res.json({ faults: simulator().setFaults(req.body ?? {}) });
});

router.get("/api/v1/simulator/faults", (_req, res) => {
  res.json({ faults: simulator().faults });
});

/** Simulate the buyer completing payment at the gateway. */
router.post(
  "/api/v1/simulator/pay",
  asyncH(async (req, res) => {
    const orderId = req.body?.orderId as string | undefined;
    if (!orderId) return res.status(400).json({ error: "orderId is required." });
    const order = orders.byId(orderId);
    if (!order) return res.status(404).json({ error: "No such order." });
    if (!order.razorpayOrderId) {
      return res.status(400).json({ error: "Order has no gateway order. Initiate payment first." });
    }

    const payment = await simulator().completePayment(order.razorpayOrderId, {
      method: (req.body?.method as string) ?? "upi",
    });

    // Deliver the webhook ourselves if the simulator emitted one. When
    // dropNextWebhook is set, nothing was emitted and the order must be
    // recovered by reconciliation instead — which is exactly the point.
    const emitted = simulator().webhookOutbox.filter((w) => w.event === "payment.captured");
    let webhookDelivered = false;
    for (const w of emitted) {
      const body = JSON.stringify(w.payload);
      if (simulator().verifyWebhookSignature(body, simulator().signPayload(w.payload))) {
        await handleCapturedWebhook(w.payload as CapturedPayload, "simulator");
        webhookDelivered = true;
      }
    }
    simulator().webhookOutbox.length = 0;

    res.json({
      payment,
      webhookDelivered,
      note: webhookDelivered
        ? "Webhook delivered; order settled normally."
        : "Webhook was dropped by fault injection. Run reconciliation to recover.",
      order: serialiseOrder(orders.byId(orderId)!),
    });
  }),
);

/* ================================================================== *
 * Admin / status
 * ================================================================== */

router.get("/api/v1/status", (_req, res) => {
  res.json({
    ok: true,
    mode: modeSummary(),
    counts: {
      products: catalog.count(),
      mandates: mandates.list().length,
      orders: orders.list({ tail: 1000 }).length,
      ledgerEntries: (db().prepare(`SELECT COUNT(*) AS n FROM ledger`).get() as { n: number }).n,
    },
    merchantPolicy: {
      ...DEFAULT_MERCHANT_POLICY,
      minMarginPaise: M.toInt(DEFAULT_MERCHANT_POLICY.minMarginPaise),
      maxBasketDiscountPaise: M.toInt(DEFAULT_MERCHANT_POLICY.maxBasketDiscountPaise),
    },
  });
});

router.post("/api/v1/admin/seed", (_req, res) => {
  const n = seedCatalog();
  res.json({ seeded: n });
});

/* ================================================================== *
 * Webhook
 * ================================================================== */

interface CapturedPayload {
  payment?: { id?: string; order_id?: string; orderId?: string; amount?: number; status?: string; method?: string };
  order?: { id?: string };
}

export async function handleCapturedWebhook(
  raw: CapturedPayload,
  via: string,
): Promise<{ ok: boolean; reason?: string }> {
  // Normalise both shapes: Razorpay's nested entity and our simulator's flatter one.
  const p = raw?.payment;
  const paymentId = p?.id;
  const gatewayOrderId = p?.order_id ?? p?.orderId;
  const amount = p?.amount;

  if (!paymentId || !gatewayOrderId) return { ok: false, reason: "Missing payment id or order id." };

  const order = orders.byRazorpayOrderId(gatewayOrderId);
  if (!order) return { ok: false, reason: `No local order for gateway order ${gatewayOrderId}.` };

  if (order.status === "paid") return { ok: true, reason: "Already settled; webhook ignored (idempotent)." };

  if (amount != null && amount !== M.toInt(order.total)) {
    ledger().append({
      action: "webhook.amount_mismatch",
      actor: { kind: "system", component: via },
      mandateId: order.mandateId,
      orderId: order.id,
      payload: { captured: amount, expected: M.toInt(order.total), decision: "Held for human review." },
    });
    return { ok: false, reason: `Captured ${amount} but expected ${M.toInt(order.total)}. Held for review.` };
  }

  orders.markPaid(order, paymentId, { via, note: "Settled from gateway webhook." });
  return { ok: true };
}

/** Mounted with express.raw so the HMAC is checked against untouched bytes. */
export const webhookRouter = Router();

webhookRouter.post("/api/v1/webhooks/razorpay", async (req, res) => {
  const signature = req.header("X-Razorpay-Signature");
  const raw = req.body as Buffer;

  if (!gateway().verifyWebhookSignature(raw, signature)) {
    ledger().append({
      action: "webhook.signature_rejected",
      actor: { kind: "system", component: "webhook" },
      payload: { note: "Rejected a webhook whose HMAC did not verify. Body was not trusted." },
    });
    return res.status(401).json({ error: "Invalid signature." });
  }

  let parsed: { event?: string; payload?: unknown };
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Malformed JSON." });
  }

  if (parsed.event === "payment.captured") {
    const result = await handleCapturedWebhook((parsed.payload ?? {}) as CapturedPayload, "webhook");
    return res.json(result);
  }

  res.json({ ok: true, ignored: parsed.event ?? "unknown" });
});

/* ================================================================== *
 * Serialisers
 * ================================================================== */

function serialiseOrder(order: ReturnType<OrderStore["byId"]>) {
  if (!order) return null;
  return {
    id: order.id,
    mandateId: order.mandateId,
    idempotencyKey: order.idempotencyKey,
    lines: order.lines.map((l) => ({
      productId: l.productId,
      title: l.title,
      qty: l.qty,
      unitPrice: M.toInt(l.unitPrice),
      unitPriceDisplay: M.format(l.unitPrice),
    })),
    subtotal: M.toInt(order.subtotal),
    discount: M.toInt(order.discount),
    shipping: M.toInt(order.shipping),
    total: M.toInt(order.total),
    totalDisplay: M.format(order.total),
    status: order.status,
    razorpayOrderId: order.razorpayOrderId ?? null,
    razorpayPaymentId: order.razorpayPaymentId ?? null,
    approval: order.approval ?? null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    history: order.history,
  };
}

function serialiseMandate(m: ReturnType<MandateStore["byId"]>) {
  if (!m) return null;
  return {
    id: m.id,
    principal: m.principal,
    purpose: m.purpose,
    perTxnCap: M.toInt(m.perTxnCap),
    totalCap: M.toInt(m.totalCap),
    spent: M.toInt(m.spent),
    remaining: M.toInt(M.sub(m.totalCap, m.spent)),
    perTxnCapDisplay: M.format(m.perTxnCap),
    totalCapDisplay: M.format(m.totalCap),
    spentDisplay: M.format(m.spent),
    remainingDisplay: M.format(M.sub(m.totalCap, m.spent)),
    approvalAbove: M.toInt(m.approvalAbove),
    approvalAboveDisplay: M.format(m.approvalAbove),
    categoryAllowlist: m.categoryAllowlist,
    maxQtyPerLine: m.maxQtyPerLine,
    expiresAt: m.expiresAt,
    status: m.status,
  };
}

export function newIdempotencyKey(): string {
  return randomUUID();
}

export { config };
