import type { Paise } from "./money";

/* ------------------------------------------------------------------ *
 * Catalog
 * ------------------------------------------------------------------ */

export interface Product {
  id: string;
  title: string;
  description: string;
  category: string;
  /** Unit price in paise. */
  price: Paise;
  /** Cost floor in paise. No discount may push a line below this. */
  costFloor: Paise;
  stock: number;
  /** Machine-readable attributes an AI buyer can filter on without guessing. */
  attributes: Record<string, string | number | boolean>;
  /** Free-text keywords the intent parser may match against. */
  tags: string[];
  /** Shipping ETA in days from a Bangalore warehouse. */
  shipsInDays: number;
}

/* ------------------------------------------------------------------ *
 * The buyer's authority — this is what makes autonomy bounded
 * ------------------------------------------------------------------ */

export type MandateScope = "purchase" | "refund";

/**
 * A mandate is the delegation of spending authority from a human principal to
 * an agent. It is deliberately narrow: an agent with no mandate can do nothing
 * that costs money. Every money action is checked against one.
 */
export interface Mandate {
  id: string;
  principal: string;
  /** Human-readable purpose; surfaced in every audit entry. */
  purpose: string;
  /** Hard ceiling on a single transaction, in paise. */
  perTxnCap: Paise;
  /** Hard ceiling on cumulative spend across the mandate's lifetime, in paise. */
  totalCap: Paise;
  /** Spend already committed against totalCap, in paise. */
  spent: Paise;
  /** Categories the agent may buy from. Empty means "any". */
  categoryAllowlist: string[];
  /** Max units of any single line item. */
  maxQtyPerLine: number;
  /** Amount above which a human must approve before money moves, in paise. */
  approvalAbove: Paise;
  currency: "INR";
  /** ISO timestamp. Expiry is checked on every evaluation, not just at issuance. */
  expiresAt: string;
  status: "active" | "revoked" | "expired";
}

/* ------------------------------------------------------------------ *
 * Decision records — the "explainable" half of the bar
 * ------------------------------------------------------------------ */

export type Decision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export interface Reason {
  /** Stable machine-readable code, e.g. PER_TXN_CAP_EXCEEDED. */
  code: string;
  /** Human (and model) readable explanation. */
  message: string;
  /** The inputs that produced this reason, so it can be re-derived later. */
  evidence?: Record<string, unknown>;
}

export interface PolicyVerdict {
  decision: Decision;
  reasons: Reason[];
  /** The mandate version this verdict was computed against. */
  mandateId: string;
  evaluatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Offers — the growth half, also bounded and explainable
 * ------------------------------------------------------------------ */

export type OfferKind = "cross_sell" | "upsell" | "bundle_discount" | "shipping" | "volume_break";

export interface Offer {
  id: string;
  kind: OfferKind;
  /** The campaign rule that produced this offer. */
  ruleId: string;
  title: string;
  /** Why this offer exists, in the buyer's terms. Shown to the AI buyer. */
  rationale: string;
  /** Discount applied to the line, in paise. Zero for non-discount kinds. */
  discount: Paise;
  /** Products this offer adds or upgrades in the cart. */
  lines: OfferLine[];
  /** Margin after discount, in paise. Must stay >= 0 or the offer is rejected. */
  projectedMargin: Paise;
}

export interface OfferLine {
  productId: string;
  qty: number;
  unitPrice: Paise;
}

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */

export type OrderStatus =
  | "draft"
  | "awaiting_approval"
  | "payment_pending"
  | "paid"
  | "failed"
  | "needs_reconciliation"
  | "refunded"
  | "abandoned";

export interface OrderLine {
  productId: string;
  title: string;
  qty: number;
  unitPrice: Paise;
  discount: Paise;
}

export interface Order {
  id: string;
  mandateId: string;
  /** Buyer-supplied idempotency key. Unique at the DB level. */
  idempotencyKey: string;
  lines: OrderLine[];
  subtotal: Paise;
  discount: Paise;
  shipping: Paise;
  total: Paise;
  status: OrderStatus;
  /** Razorpay order id, once created. */
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  /** Set when a human or a policy gate had to clear this. */
  approval?: ApprovalRecord;
  createdAt: string;
  updatedAt: string;
  /** Append-only status transitions, mirrored into the audit ledger. */
  history: OrderEvent[];
}

export interface OrderEvent {
  at: string;
  from: OrderStatus | null;
  to: OrderStatus;
  note: string;
}

export interface ApprovalRecord {
  by: string;
  at: string;
  decision: "approved" | "rejected";
  note?: string;
}

/* ------------------------------------------------------------------ *
 * The agent
 * ------------------------------------------------------------------ */

export interface PurchaseIntent {
  /** Normalised search terms, extracted not invented. */
  terms: string[];
  category?: string;
  maxUnitPrice?: Paise;
  qty: number;
  /** Hard requirement, e.g. delivery deadline. */
  maxShipsInDays?: number;
  /** Attribute constraints the agent must respect: {"material": "mesh"} */
  attributeFilters: Record<string, string | number | boolean>;
  /** The raw text, preserved for the audit trail. */
  raw: string;
  /** How confident the parse is; low confidence triggers a clarification gate. */
  confidence: number;
  /** Whether the intent came from the model or the deterministic fallback. */
  source: "llm" | "heuristic";
}

export interface RunStep {
  seq: number;
  kind: "plan" | "discover" | "evaluate" | "offer" | "gate" | "pay" | "recover" | "done";
  summary: string;
  detail?: Record<string, unknown>;
  at: string;
}

export interface AgentRun {
  id: string;
  mandateId: string;
  intent: PurchaseIntent;
  steps: RunStep[];
  outcome: "completed" | "denied" | "awaiting_approval" | "failed";
  orderId?: string;
  startedAt: string;
  finishedAt?: string;
}
