import * as M from "../domain/money";
import type { Product } from "../domain/types";
import { config } from "../config";

/**
 * The "agent-readable catalog".
 *
 * Today an AI buyer that wants to shop a merchant has to scrape HTML and guess
 * which div is the price. That is fragile for the buyer and uncontrollable for
 * the merchant — the merchant has no way to say "this is out of stock", "this
 * is not discountable", or "here is the endpoint that will actually take an
 * order".
 *
 * This module publishes the merchant's inventory and capabilities as structured
 * data an agent can consume directly. It is intentionally close to the shape
 * emerging across ACP / AP2 / UAP: a discovery manifest, a typed product feed,
 * and a checkout endpoint, with payment rails declared up front.
 */

export const FEED_VERSION = "1.0";

export interface FeedManifest {
  feed_version: string;
  merchant: {
    name: string;
    description: string;
    currency: "INR";
    country: "IN";
    settlement_rails: string[];
  };
  /** What an agent is allowed to do here, and where. */
  capabilities: {
    discovery: string;
    product_feed: string;
    offers: string;
    quote: string;
    checkout: string;
    order_status: string;
    human_readable_terms: string;
  };
  payment: {
    provider: "razorpay";
    mode: "test" | "live";
    /** Methods an agent-initiated order may use. Narrow on purpose. */
    allowed_methods: string[];
    /** Money is never captured without a server-side order; state this plainly. */
    order_flow: "server_side_order_then_payment";
  };
  /** Constraints an agent MUST respect. Violations are rejected, not warned. */
  agent_constraints: {
    requires_mandate: true;
    max_qty_per_line: number;
    idempotency_required: true;
    idempotency_header: string;
    quote_validity_seconds: number;
    notes: string[];
  };
  updated_at: string;
}

export function buildManifest(opts: { maxQtyPerLine: number; mode: "test" | "live" }): FeedManifest {
  return {
    feed_version: FEED_VERSION,
    merchant: {
      name: "Bengaluru Ergo",
      description: "Ergonomic office furniture and accessories. Ships across India from Bengaluru.",
      currency: "INR",
      country: "IN",
      settlement_rails: ["upi", "cards", "netbanking"],
    },
    capabilities: {
      discovery: "/.well-known/agent-commerce.json",
      product_feed: "/api/v1/feed/products",
      offers: "/api/v1/feed/offers",
      quote: "/api/v1/commerce/quote",
      checkout: "/api/v1/commerce/orders",
      order_status: "/api/v1/commerce/orders/{id}",
      human_readable_terms: "/terms",
    },
    payment: {
      provider: "razorpay",
      mode: opts.mode,
      allowed_methods: ["upi", "card", "netbanking"],
      order_flow: "server_side_order_then_payment",
    },
    agent_constraints: {
      requires_mandate: true,
      max_qty_per_line: opts.maxQtyPerLine,
      idempotency_required: true,
      idempotency_header: "Idempotency-Key",
      quote_validity_seconds: 900,
      notes: [
        "All amounts are integer paise. Never send rupees as decimals.",
        "Every mutating call must carry an Idempotency-Key; replays return the original result.",
        "A quote is a price promise for 900 seconds only. Re-quote after that.",
        "Orders above the mandate's approval threshold pause for a human. This is not an error.",
      ],
    },
    updated_at: new Date().toISOString(),
  };
}

export interface FeedProduct {
  id: string;
  title: string;
  description: string;
  category: string;
  /** Integer paise. */
  price_paise: number;
  price_display: string;
  currency: "INR";
  in_stock: boolean;
  stock_qty: number;
  ships_in_days: number;
  attributes: Record<string, string | number | boolean>;
  tags: string[];
  /** False means no campaign may discount this line. */
  discountable: boolean;
}

export function toFeedProduct(p: Product): FeedProduct {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    category: p.category,
    price_paise: M.toInt(p.price),
    price_display: M.format(p.price),
    currency: "INR",
    in_stock: p.stock > 0,
    stock_qty: p.stock,
    ships_in_days: p.shipsInDays,
    attributes: p.attributes,
    tags: p.tags,
    discountable: p.attributes.discountable !== false && p.category !== "gift_cards",
  };
}

/**
 * A plain-text projection of the catalog for agents that would rather read
 * tokens than parse JSON. Same data, no schema to get wrong.
 */
export function toLlmsTxt(products: Product[]): string {
  const lines: string[] = [];
  lines.push("# Bengaluru Ergo");
  lines.push("");
  lines.push("> Ergonomic office furniture, Bengaluru, India. Prices in INR, integer paise.");
  lines.push("");
  lines.push("## How to buy as an agent");
  lines.push("");
  lines.push(`1. Read the manifest at ${config.publicUrl}/.well-known/agent-commerce.json`);
  lines.push(`2. POST ${config.publicUrl}/api/v1/commerce/quote with your cart and mandate id`);
  lines.push(`3. POST ${config.publicUrl}/api/v1/commerce/orders with an Idempotency-Key to pay`);
  lines.push("4. Poll order status. A missing webhook is recovered automatically; do not re-pay.");
  lines.push("");
  lines.push("## Catalog");
  lines.push("");

  const byCategory = new Map<string, Product[]>();
  for (const p of products) {
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category)!.push(p);
  }

  for (const [category, items] of byCategory) {
    lines.push(`### ${category}`);
    lines.push("");
    for (const p of items) {
      const stock = p.stock > 0 ? `${p.stock} in stock` : "out of stock";
      lines.push(`- ${p.id} — ${p.title} — ${M.format(p.price)} — ${stock}, ships in ${p.shipsInDays}d`);
      lines.push(`  ${p.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
