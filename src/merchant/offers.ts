import { randomUUID } from "node:crypto";
import * as M from "../domain/money";
import type { Offer, OfferLine, Product } from "../domain/types";
import { evaluateOffer, type MerchantPolicy } from "../governance/policy";
import { CatalogRepository } from "../catalog/repository";

/**
 * The campaign orchestrator — the growth half.
 *
 * The important design decision: offers are *generated* freely but *published*
 * only if they clear the merchant's own policy. A discount engine with no floor
 * is an unbudgeted spend with better branding, so every candidate offer goes
 * through the same gate the buyer's money does. Rejected offers are returned
 * too, with their rejection reason — that is what makes the pipeline debuggable
 * when a merchant asks "why didn't my campaign fire?".
 *
 * Note what is NOT here: no model. Recommendations are deterministic rules over
 * a catalog graph. An LLM would happily invent a bundle that loses money on a
 * low-margin SKU; a margin floor computed in integer paise will not.
 */

export interface CartLine {
  productId: string;
  qty: number;
}

export interface PricedLine extends CartLine {
  product: Product;
  unitPrice: M.Paise;
  lineTotal: M.Paise;
}

export const SHIPPING_FEE: M.Paise = M.paise(499);
export const FREE_SHIPPING_ABOVE: M.Paise = M.paise(15000);

export const DEFAULT_MERCHANT_POLICY: MerchantPolicy = {
  id: "policy-bengaluru-ergo",
  maxDiscountBps: 1500, // 15%
  minMarginPaise: M.paise(1500),
  maxBasketDiscountPaise: M.paise(4000),
  noDiscountCategories: ["gift_cards"],
};

export function priceLines(cart: CartLine[], catalog: CatalogRepository): PricedLine[] {
  return cart.map((line) => {
    const product = catalog.byId(line.productId);
    if (!product) throw new Error(`Unknown product: ${line.productId}`);
    return {
      ...line,
      product,
      unitPrice: product.price,
      lineTotal: M.mulQty(product.price, line.qty),
    };
  });
}

export function subtotalOf(priced: PricedLine[]): M.Paise {
  return priced.reduce((acc, l) => M.add(acc, l.lineTotal), M.paise(0));
}

/** Gross margin before any discount, in integer paise. */
export function marginOf(priced: PricedLine[]): M.Paise {
  return priced.reduce(
    (acc, l) => M.add(acc, M.mulQty(M.sub(l.product.price, l.product.costFloor), l.qty)),
    M.paise(0),
  );
}

export function shippingFor(subtotal: M.Paise): M.Paise {
  return subtotal >= M.toInt(FREE_SHIPPING_ABOVE) ? M.paise(0) : SHIPPING_FEE;
}

interface RuleContext {
  priced: PricedLine[];
  subtotal: M.Paise;
  catalog: CatalogRepository;
  has(productId: string): boolean;
}

interface CampaignRule {
  id: string;
  kind: Offer["kind"];
  title: string;
  /** Why this exists, in language an AI buyer can act on. */
  rationale(ctx: RuleContext): string;
  /** Null means the rule does not fire for this cart. */
  build(ctx: RuleContext): { lines: OfferLine[]; discountBps: number } | null;
}

const COMPLEMENTS: Array<{ trigger: (ctx: RuleContext) => boolean; productId: string; why: string }> = [
  {
    trigger: (c) => c.priced.some((l) => l.product.category === "seating"),
    productId: "footrest-ergo",
    why: "Task chairs are usually bought for posture. A footrest is the cheapest completion of that outcome and the highest-attach accessory we sell.",
  },
  {
    trigger: (c) => c.priced.some((l) => l.product.category === "desks" && l.product.attributes.motor === "dual"),
    productId: "monitor-arm-dual",
    why: "A sit-stand desk changes eye height through the day. A dual monitor arm keeps screens at eye level without re-stacking them every time.",
  },
  {
    trigger: (c) => c.priced.some((l) => l.product.attributes.material === "mesh"),
    productId: "lumbar-cushion",
    why: "Mesh chairs trade some padding for breathability. A lumbar cushion restores the support without the heat.",
  },
  {
    trigger: (c) => c.priced.some((l) => l.product.category === "desks"),
    productId: "keyboard-tray-underdesk",
    why: "Standing desks are usually set a little too high for typing. A tray puts the keyboard back at elbow height when standing.",
  },
];

export const CAMPAIGN_RULES: CampaignRule[] = [
  {
    id: "rule-crosssell-complement",
    kind: "cross_sell",
    title: "Complete-the-setup accessory",
    rationale: (ctx) => {
      const hit = COMPLEMENTS.find((c) => c.trigger(ctx));
      return hit?.why ?? "Related accessory for items in your cart.";
    },
    build: (ctx) => {
      for (const comp of COMPLEMENTS) {
        if (!comp.trigger(ctx)) continue;
        if (ctx.has(comp.productId)) continue;
        const product = ctx.catalog.byId(comp.productId);
        if (!product || product.stock <= 0) continue;
        return { lines: [{ productId: product.id, qty: 1, unitPrice: product.price }], discountBps: 0 };
      }
      return null;
    },
  },
  {
    id: "rule-upsell-chair-tier",
    kind: "upsell",
    title: "Upgrade to MeshPro",
    rationale: () =>
      "MeshPro adds 4D armrests, a third year of warranty and a 130kg load rating over MeshLite. For an 8-hour-per-day user the warranty alone usually covers the difference.",
    build: (ctx) => {
      const lite = ctx.priced.find((l) => l.productId === "ergo-chair-mesh-lite");
      if (!lite) return null;
      const pro = ctx.catalog.byId("ergo-chair-mesh-pro");
      if (!pro || pro.stock < lite.qty || ctx.has("ergo-chair-mesh-pro")) return null;
      return {
        lines: [{ productId: pro.id, qty: lite.qty, unitPrice: pro.price }],
        discountBps: 500, // 5% softens the step-up
      };
    },
  },
  {
    id: "rule-bundle-desk-chair",
    kind: "bundle_discount",
    title: "Desk + chair bundle",
    rationale: () =>
      "Desk and chair bought together ship as one consignment, which cuts our freight enough to share 7% back.",
    build: (ctx) => {
      const hasDesk = ctx.priced.some((l) => l.product.category === "desks");
      const hasChair = ctx.priced.some((l) => l.product.category === "seating");
      if (!hasDesk || !hasChair) return null;
      return { lines: [], discountBps: 700 };
    },
  },
  {
    id: "rule-volume-break",
    kind: "volume_break",
    title: "Volume break at 5 units",
    rationale: () =>
      "Five or more units of a single line qualifies for a 5% volume break.",
    build: (ctx) => {
      const qualifies = ctx.priced.some((l) => l.qty >= 5);
      if (!qualifies) return null;
      return { lines: [], discountBps: 500 };
    },
  },
  {
    id: "rule-shipping-threshold",
    kind: "shipping",
    title: "Free shipping nudge",
    rationale: (ctx) => {
      const gap = M.sub(FREE_SHIPPING_ABOVE, ctx.subtotal);
      return `Your cart is ${M.format(gap)} short of free shipping. Adding this clears the threshold and saves the ${M.format(SHIPPING_FEE)} delivery fee.`;
    },
    build: (ctx) => {
      if (ctx.subtotal >= M.toInt(FREE_SHIPPING_ABOVE)) return null;
      const gap = M.sub(FREE_SHIPPING_ABOVE, ctx.subtotal);
      // Only worth nudging if the gap is small relative to the fee we'd waive.
      if (gap > M.toInt(SHIPPING_FEE)) return null;
      const candidate = ctx.catalog
        .all()
        .filter((p) => p.stock > 0 && p.price >= M.toInt(gap) && p.category === "accessories")
        .sort((a, b) => a.price - b.price)[0];
      if (!candidate) return null;
      return { lines: [{ productId: candidate.id, qty: 1, unitPrice: candidate.price }], discountBps: 0 };
    },
  },
];

export interface EvaluatedOffer {
  offer: Offer;
  verdict: "ALLOW" | "DENY";
  reasons: string[];
}

/**
 * Generate every candidate offer, price it, gate it, and return both the
 * survivors and the rejected with their reasons.
 */
export function generateOffers(
  cart: CartLine[],
  catalog: CatalogRepository,
  policy: MerchantPolicy = DEFAULT_MERCHANT_POLICY,
): { priced: PricedLine[]; subtotal: M.Paise; allowed: EvaluatedOffer[]; rejected: EvaluatedOffer[] } {
  const priced = priceLines(cart, catalog);
  const subtotal = subtotalOf(priced);
  const cartProductIds = new Set(cart.map((l) => l.productId));

  const ctx: RuleContext = {
    priced,
    subtotal,
    catalog,
    has: (id) => cartProductIds.has(id),
  };

  const allowed: EvaluatedOffer[] = [];
  const rejected: EvaluatedOffer[] = [];

  for (const rule of CAMPAIGN_RULES) {
    const built = rule.build(ctx);
    if (!built) continue;

    // Margin is computed over the cart WITH the offer applied, minus the discount.
    const combinedLines: PricedLine[] = [
      ...priced,
      ...built.lines.map((l) => {
        const product = catalog.byId(l.productId);
        if (!product) throw new Error(`Offer referenced unknown product: ${l.productId}`);
        return { productId: l.productId, qty: l.qty, product, unitPrice: l.unitPrice, lineTotal: M.mulQty(l.unitPrice, l.qty) };
      }),
    ];

    const combinedSubtotal = subtotalOf(combinedLines);
    const discount = M.applyBps(combinedSubtotal, built.discountBps);
    const projectedMargin = M.sub(marginOf(combinedLines), discount);

    const offer: Offer = {
      id: `${rule.id}-${randomUUID().slice(0, 8)}`,
      kind: rule.kind,
      ruleId: rule.id,
      title: rule.title,
      rationale: rule.rationale(ctx),
      discount,
      lines: built.lines,
      projectedMargin,
    };

    const categories = [...new Set(combinedLines.map((l) => l.product.category))];
    const verdict = evaluateOffer(offer, policy, {
      subtotal: combinedSubtotal,
      basketDiscountSoFar: M.paise(0),
      categories,
    });

    const evaluated: EvaluatedOffer = {
      offer,
      verdict: verdict.decision === "ALLOW" ? "ALLOW" : "DENY",
      reasons: verdict.reasons.map((r) => `${r.code}: ${r.message}`),
    };

    (verdict.decision === "ALLOW" ? allowed : rejected).push(evaluated);
  }

  // Highest margin contribution first — we grow revenue, not just basket size.
  allowed.sort((a, b) => M.toInt(b.offer.projectedMargin) - M.toInt(a.offer.projectedMargin));
  return { priced, subtotal, allowed, rejected };
}
