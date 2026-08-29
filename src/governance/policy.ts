import type { Mandate, Offer, PolicyVerdict, Reason, Decision } from "../domain/types";
import * as M from "../domain/money";

/**
 * The gate.
 *
 * This module is the only place that can authorise an agent to move money, and
 * it is deliberately dumb: pure functions over integers and strings, no I/O, no
 * model calls, no network. If you can't read it top to bottom and predict the
 * verdict, it has no business guarding a payment.
 *
 * A design note worth defending: we collect ALL deny reasons rather than
 * short-circuiting on the first. An agent that is told "denied" learns nothing;
 * an agent told "denied because you are over the per-transaction cap AND the
 * category is not on the allowlist" can actually correct itself.
 */

export interface PurchaseCandidate {
  total: M.Paise;
  categories: string[];
  maxLineQty: number;
  now?: Date;
}

/** Merchant-side guardrails on discounting. Separate from the buyer's mandate. */
export interface MerchantPolicy {
  id: string;
  /** Deepest discount any single offer may apply, in basis points. */
  maxDiscountBps: number;
  /** No campaign may push a cart below this absolute margin. */
  minMarginPaise: M.Paise;
  /** Hard stop on total basket discount per order. */
  maxBasketDiscountPaise: M.Paise;
  /** Categories where discounting is disallowed (e.g. regulated/prepaid). */
  noDiscountCategories: string[];
}

function deny(code: string, message: string, evidence?: Record<string, unknown>): Reason {
  return { code, message, evidence };
}

/**
 * Evaluate a prospective purchase against a mandate.
 * Precedence: DENY outranks REQUIRE_APPROVAL outranks ALLOW.
 */
export function evaluatePurchase(
  mandate: Mandate,
  candidate: PurchaseCandidate,
  now: Date = new Date(),
): PolicyVerdict {
  const reasons: Reason[] = [];

  // --- Revocation and expiry first: an invalid mandate voids everything else.
  if (mandate.status === "revoked") {
    reasons.push(deny("MANDATE_REVOKED", `Mandate ${mandate.id} has been revoked by its principal.`));
  } else if (mandate.status === "expired") {
    reasons.push(deny("MANDATE_EXPIRED", `Mandate ${mandate.id} is marked expired.`));
  } else if (new Date(mandate.expiresAt).getTime() <= now.getTime()) {
    reasons.push(
      deny(
        "MANDATE_EXPIRED",
        `Mandate ${mandate.id} expired at ${mandate.expiresAt}; evaluated at ${now.toISOString()}.`,
        { expiresAt: mandate.expiresAt, now: now.toISOString() },
      ),
    );
  }

  // --- Scope checks.
  if (mandate.categoryAllowlist.length > 0) {
    const disallowed = candidate.categories.filter((c) => !mandate.categoryAllowlist.includes(c));
    if (disallowed.length > 0) {
      reasons.push(
        deny(
          "CATEGORY_NOT_ALLOWED",
          `Categories ${disallowed.join(", ")} are outside the mandate's allowlist (${mandate.categoryAllowlist.join(", ")}).`,
          { disallowed, allowlist: mandate.categoryAllowlist },
        ),
      );
    }
  }

  if (candidate.maxLineQty > mandate.maxQtyPerLine) {
    reasons.push(
      deny(
        "QTY_PER_LINE_EXCEEDED",
        `A line has ${candidate.maxLineQty} units, above the mandate limit of ${mandate.maxQtyPerLine}.`,
        { requested: candidate.maxLineQty, limit: mandate.maxQtyPerLine },
      ),
    );
  }

  if (candidate.total > mandate.perTxnCap) {
    reasons.push(
      deny(
        "PER_TXN_CAP_EXCEEDED",
        `Order total ${M.format(candidate.total)} exceeds the per-transaction cap of ${M.format(mandate.perTxnCap)}.`,
        { total: M.toInt(candidate.total), perTxnCap: M.toInt(mandate.perTxnCap) },
      ),
    );
  }

  const remaining = M.sub(mandate.totalCap, mandate.spent);
  if (candidate.total > remaining) {
    reasons.push(
      deny(
        "TOTAL_CAP_EXCEEDED",
        `Order total ${M.format(candidate.total)} exceeds remaining authority of ${M.format(remaining)} (${M.format(mandate.spent)} already spent of ${M.format(mandate.totalCap)}).`,
        {
          total: M.toInt(candidate.total),
          remaining: M.toInt(remaining),
          spent: M.toInt(mandate.spent),
          totalCap: M.toInt(mandate.totalCap),
        },
      ),
    );
  }

  if (reasons.length > 0) {
    return {
      decision: "DENY" as Decision,
      reasons,
      mandateId: mandate.id,
      evaluatedAt: now.toISOString(),
    };
  }

  // --- Nothing forbidden, but above the trust threshold: a human must clear it.
  if (candidate.total > mandate.approvalAbove) {
    return {
      decision: "REQUIRE_APPROVAL" as Decision,
      reasons: [
        {
          code: "ABOVE_APPROVAL_THRESHOLD",
          message: `Order total ${M.format(candidate.total)} is above the auto-approve threshold of ${M.format(mandate.approvalAbove)}. A human must approve before money moves.`,
          evidence: { total: M.toInt(candidate.total), approvalAbove: M.toInt(mandate.approvalAbove) },
        },
      ],
      mandateId: mandate.id,
      evaluatedAt: now.toISOString(),
    };
  }

  return {
    decision: "ALLOW" as Decision,
    reasons: [
      {
        code: "WITHIN_MANDATE",
        message: `Order total ${M.format(candidate.total)} is within per-transaction cap ${M.format(mandate.perTxnCap)}, within remaining authority ${M.format(remaining)}, and below the approval threshold ${M.format(mandate.approvalAbove)}.`,
        evidence: {
          total: M.toInt(candidate.total),
          remaining: M.toInt(remaining),
          approvalAbove: M.toInt(mandate.approvalAbove),
        },
      },
    ],
    mandateId: mandate.id,
    evaluatedAt: now.toISOString(),
  };
}

/**
 * Evaluate a merchant-side offer before it is ever shown to a buyer.
 *
 * The growth half needs a gate too — an over-eager discount engine is just an
 * unbudgeted spend with better branding. This enforces the merchant's own floor.
 */
export function evaluateOffer(
  offer: Offer,
  policy: MerchantPolicy,
  cart: { subtotal: M.Paise; basketDiscountSoFar: M.Paise; categories: string[] },
): PolicyVerdict {
  const reasons: Reason[] = [];

  const protectedHit = cart.categories.filter((c) => policy.noDiscountCategories.includes(c));
  if (protectedHit.length > 0 && offer.discount > 0) {
    reasons.push(
      deny("NO_DISCOUNT_CATEGORY", `Cart contains protected categories: ${protectedHit.join(", ")}.`, {
        protectedHit,
      }),
    );
  }

  if (offer.discount > 0 && cart.subtotal > 0) {
    const bps = Math.round((M.toInt(offer.discount) / M.toInt(cart.subtotal)) * 10_000);
    if (bps > policy.maxDiscountBps) {
      reasons.push(
        deny(
          "DISCOUNT_ABOVE_CEILING",
          `Offer discounts ${bps} bps, above the merchant ceiling of ${policy.maxDiscountBps} bps.`,
          { bps, ceiling: policy.maxDiscountBps },
        ),
      );
    }
  }

  const projectedBasketDiscount = M.add(cart.basketDiscountSoFar, offer.discount);
  if (projectedBasketDiscount > policy.maxBasketDiscountPaise) {
    reasons.push(
      deny(
        "BASKET_DISCOUNT_CAP_EXCEEDED",
        `Applying this offer would bring basket discount to ${M.format(projectedBasketDiscount)}, above the cap of ${M.format(policy.maxBasketDiscountPaise)}.`,
        { projected: M.toInt(projectedBasketDiscount), cap: M.toInt(policy.maxBasketDiscountPaise) },
      ),
    );
  }

  if (offer.projectedMargin < M.toInt(policy.minMarginPaise)) {
    reasons.push(
      deny(
        "MARGIN_FLOOR_BREACHED",
        `Offer would leave ${M.format(offer.projectedMargin as M.Paise)} margin, below the floor of ${M.format(policy.minMarginPaise)}.`,
        { projectedMargin: M.toInt(offer.projectedMargin as M.Paise), floor: M.toInt(policy.minMarginPaise) },
      ),
    );
  }

  if (reasons.length > 0) {
    return { decision: "DENY", reasons, mandateId: policy.id, evaluatedAt: new Date().toISOString() };
  }

  return {
    decision: "ALLOW",
    reasons: [
      {
        code: "OFFER_WITHIN_POLICY",
        message: `Offer ${offer.id} clears margin floor and discount ceilings.`,
        evidence: { discount: M.toInt(offer.discount), margin: M.toInt(offer.projectedMargin as M.Paise) },
      },
    ],
    mandateId: policy.id,
    evaluatedAt: new Date().toISOString(),
  };
}

/** Refunds are money actions too, and get the same treatment. */
export function evaluateRefund(
  mandate: Mandate,
  amount: M.Paise,
  now: Date = new Date(),
): PolicyVerdict {
  if (mandate.status !== "active") {
    return {
      decision: "DENY",
      reasons: [deny("MANDATE_NOT_ACTIVE", `Mandate ${mandate.id} is ${mandate.status}.`)],
      mandateId: mandate.id,
      evaluatedAt: now.toISOString(),
    };
  }
  if (amount > mandate.approvalAbove) {
    return {
      decision: "REQUIRE_APPROVAL",
      reasons: [
        {
          code: "REFUND_ABOVE_THRESHOLD",
          message: `Refund of ${M.format(amount)} is above the auto-approve threshold of ${M.format(mandate.approvalAbove)}.`,
          evidence: { amount: M.toInt(amount), threshold: M.toInt(mandate.approvalAbove) },
        },
      ],
      mandateId: mandate.id,
      evaluatedAt: now.toISOString(),
    };
  }
  return {
    decision: "ALLOW",
    reasons: [
      {
        code: "REFUND_WITHIN_THRESHOLD",
        message: `Refund of ${M.format(amount)} is within the auto-approve threshold.`,
        evidence: { amount: M.toInt(amount) },
      },
    ],
    mandateId: mandate.id,
    evaluatedAt: now.toISOString(),
  };
}
