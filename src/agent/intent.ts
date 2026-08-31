import * as M from "../domain/money";
import type { PurchaseIntent } from "../domain/types";
import { config, llmEnabled } from "../config";

/**
 * Natural language -> typed PurchaseIntent.
 *
 * Where we use a model, and where we deliberately do not:
 *
 *   USE the model for: mapping messy human phrasing onto a structured intent.
 *   This is genuinely fuzzy, the failure mode is recoverable, and a wrong parse
 *   gets caught downstream by the catalog filters and the policy gate.
 *
 *   DO NOT use the model for: prices, totals, discounts, mandate evaluation, or
 *   payment authorisation. Those are integer arithmetic against a mandate. A
 *   model that computes money will eventually compute it wrong, and there is no
 *   downstream gate that catches an arithmetic hallucination before the charge.
 *
 * So the model's output here is treated as untrusted input: it is schema
 * validated, clamped to sane ranges, and any failure falls back to the
 * deterministic parser. The system runs correctly with no API key at all.
 */

const CATEGORY_KEYWORDS: Array<{ category: string; words: string[] }> = [
  { category: "seating", words: ["chair", "chairs", "seat", "seating", "stool"] },
  { category: "desks", words: ["desk", "desks", "table", "workstation", "standing desk", "sit-stand"] },
  { category: "accessories", words: ["accessory", "accessories", "mat", "lamp", "arm", "cushion", "footrest", "tray", "panel"] },
  { category: "gift_cards", words: ["gift card", "voucher", "giftcard"] },
];

const ATTRIBUTE_HINTS: Array<{ match: RegExp; key: string; value: string | number | boolean }> = [
  { match: /\bmesh\b/i, key: "material", value: "mesh" },
  { match: /\bleather\b/i, key: "material", value: "leather" },
  { match: /\b(bamboo|laminate|mdf)\b/i, key: "topMaterial", value: "$1" },
  { match: /\bdual motor|dual-motor\b/i, key: "motor", value: "dual" },
  { match: /\blumbar\b/i, key: "lumbar", value: true },
  { match: /\bdual (?:monitor|screen)/i, key: "monitors", value: 2 },
];

const STOPWORDS = new Set([
  "i", "need", "want", "buy", "purchase", "get", "me", "a", "an", "the", "some", "for", "our",
  "my", "please", "with", "and", "that", "can", "ship", "deliver", "delivered", "delivery",
  "under", "below", "less", "than", "each", "per", "within", "by", "in", "of", "to", "office",
  "budget", "around", "about", "roughly", "max", "maximum", "rs", "inr", "rupees", "rupee",
]);

export interface ParseResult {
  intent: PurchaseIntent;
  /** Set when a model was attempted but rejected or unavailable. */
  degradedFrom?: "llm";
  degradationReason?: string;
}

export async function parseIntent(raw: string, opts: { forceHeuristic?: boolean } = {}): Promise<ParseResult> {
  if (llmEnabled() && !opts.forceHeuristic) {
    try {
      const parsed = await parseWithModel(raw);
      if (parsed) return { intent: parsed };
      return {
        intent: heuristicParse(raw),
        degradedFrom: "llm",
        degradationReason: "Model returned no usable output.",
      };
    } catch (err) {
      return {
        intent: heuristicParse(raw),
        degradedFrom: "llm",
        degradationReason: (err as Error).message,
      };
    }
  }
  return { intent: heuristicParse(raw) };
}

/* ------------------------------------------------------------------ *
 * Model path
 * ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You convert a shopping request into a strict JSON purchase intent for an Indian office-furniture catalog.

Rules:
- Output ONLY JSON. No prose, no markdown fences.
- All monetary amounts are in RUPEES as plain numbers, no symbols or commas.
- "qty" is the number of units of the primary item requested. Default 1.
- "category" must be one of: seating, desks, accessories, gift_cards, or null if unclear.
- "attributeFilters" must only use these keys: material, lumbar, armrests, motor, monitors, topMaterial, warrantyYears, adjustable, sliding, washable.
- "confidence" is your own 0.0-1.0 estimate of how well you understood the request.
- Extract only what is stated or strongly implied. Never invent requirements.

Schema:
{"terms": string[], "category": string|null, "maxUnitPrice": number|null, "qty": number, "maxShipsInDays": number|null, "attributeFilters": object, "confidence": number}`;

async function parseWithModel(raw: string): Promise<PurchaseIntent | null> {
  const controller = new AbortController();
  // A slow model must not stall a purchase run. We fall back rather than hang.
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: raw },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;
    return validateIntent(JSON.parse(content), raw);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The model's output is untrusted. Clamp every field to a sane range and reject
 * anything that cannot be coerced, rather than letting a hallucinated number
 * become a budget ceiling.
 */
function validateIntent(obj: unknown, raw: string): PurchaseIntent | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;

  const qtyRaw = Number(o.qty);
  const qty = Number.isFinite(qtyRaw) ? Math.min(Math.max(Math.trunc(qtyRaw), 1), 50) : 1;

  const priceRaw = o.maxUnitPrice;
  let maxUnitPrice: M.Paise | undefined;
  if (typeof priceRaw === "number" && Number.isFinite(priceRaw) && priceRaw > 0 && priceRaw < 10_000_000) {
    maxUnitPrice = M.paise(priceRaw);
  }

  const shipsRaw = o.maxShipsInDays;
  let maxShipsInDays: number | undefined;
  if (typeof shipsRaw === "number" && Number.isFinite(shipsRaw) && shipsRaw > 0 && shipsRaw <= 90) {
    maxShipsInDays = Math.trunc(shipsRaw);
  }

  const category =
    typeof o.category === "string" &&
    ["seating", "desks", "accessories", "gift_cards"].includes(o.category)
      ? o.category
      : undefined;

  const attributeFilters: Record<string, string | number | boolean> = {};
  const ALLOWED = new Set([
    "material", "lumbar", "armrests", "motor", "monitors", "topMaterial",
    "warrantyYears", "adjustable", "sliding", "washable",
  ]);
  if (typeof o.attributeFilters === "object" && o.attributeFilters !== null) {
    for (const [k, v] of Object.entries(o.attributeFilters as Record<string, unknown>)) {
      if (!ALLOWED.has(k)) continue;
      if (typeof v === "string" || typeof v === "boolean") attributeFilters[k] = v;
      else if (typeof v === "number" && Number.isFinite(v)) attributeFilters[k] = v;
    }
  }

  const confRaw = Number(o.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.min(Math.max(confRaw, 0), 1) : 0.5;

  const terms = Array.isArray(o.terms)
    ? o.terms.filter((t): t is string => typeof t === "string").slice(0, 12)
    : extractTerms(raw);
  if (terms.length === 0) return null;

  return {
    terms,
    category,
    maxUnitPrice,
    qty,
    maxShipsInDays,
    attributeFilters,
    raw,
    confidence,
    source: "llm",
  };
}

/* ------------------------------------------------------------------ *
 * Deterministic path
 * ------------------------------------------------------------------ */

export function heuristicParse(raw: string): PurchaseIntent {
  const text = raw.toLowerCase();

  // Quantity: "3 chairs", "3x chairs", "three chairs"
  let qty = 1;
  const numWord: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const qtyMatch = /(\d+)\s*(?:x\s+)?(?=\w)/.exec(text) ?? /\b(\d+)\s*$/.exec(text);
  if (qtyMatch) qty = Math.min(Math.max(parseInt(qtyMatch[1], 10), 1), 50);
  else {
    for (const [word, n] of Object.entries(numWord)) {
      if (new RegExp(`\\b${word}\\b`).test(text)) {
        qty = n;
        break;
      }
    }
  }

  // Price ceiling: "under 15000", "below ₹15,000", "less than 20k"
  let maxUnitPrice: M.Paise | undefined;
  const priceMatch = /(?:under|below|less than|max|maximum|upto|up to)\s*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(k|lakh|lac)?/i.exec(text);
  if (priceMatch) {
    let value = Number(priceMatch[1].replace(/,/g, ""));
    if (priceMatch[2]?.toLowerCase() === "k") value *= 1000;
    if (/lakh|lac/i.test(priceMatch[2] ?? "")) value *= 100_000;
    if (Number.isFinite(value) && value > 0) maxUnitPrice = M.paise(value);
  }

  // Delivery window
  let maxShipsInDays: number | undefined;
  const daysMatch = /(?:within|in|under)\s+(\d+)\s+days?/.exec(text);
  if (daysMatch) maxShipsInDays = parseInt(daysMatch[1], 10);
  else if (/\bby friday\b|\bthis week\b/.test(text)) maxShipsInDays = 5;
  else if (/\btomorrow\b|\burgent\b|\basap\b/.test(text)) maxShipsInDays = 2;

  let category: string | undefined;
  for (const entry of CATEGORY_KEYWORDS) {
    if (entry.words.some((w) => text.includes(w))) {
      category = entry.category;
      break;
    }
  }

  const attributeFilters: Record<string, string | number | boolean> = {};
  for (const hint of ATTRIBUTE_HINTS) {
    const m = hint.match.exec(text);
    if (m) {
      attributeFilters[hint.key] =
        typeof hint.value === "string" && hint.value === "$1" ? m[1].toLowerCase() : hint.value;
    }
  }

  const terms = extractTerms(raw);
  // Confidence must start BELOW the rejection floor, or a request we understood
  // nothing about would still clear the gate and spend money. Every point above
  // the base has to be earned by something we actually extracted.
  let confidence = 0.25;
  if (terms.length >= 1) confidence += 0.1;
  if (terms.length >= 2) confidence += 0.1;
  if (category) confidence += 0.2;
  if (maxUnitPrice) confidence += 0.15;
  if (qty > 1) confidence += 0.05;
  confidence = Math.min(confidence, 0.9);

  return {
    terms,
    category,
    maxUnitPrice,
    qty,
    maxShipsInDays,
    attributeFilters,
    raw,
    confidence,
    source: "heuristic",
  };
}

function extractTerms(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .slice(0, 12);
}
