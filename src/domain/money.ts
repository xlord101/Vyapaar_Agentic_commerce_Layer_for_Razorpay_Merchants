/**
 * Money is stored and computed as integer paise. Always.
 *
 * Floats lose precision at exactly the wrong moment — the moment money is real.
 * A discount of 12.5% on ₹1,999 computed in floats can land a paisa off, and a
 * paisa off is a reconciliation bug that costs more to find than to prevent.
 *
 * Everything in this system that touches an amount goes through here.
 */

export type Paise = number & { readonly __brand: "Paise" };

/** Parse a rupee amount (number or string) into integer paise. Rounds half-up. */
export function paise(rupees: number | string): Paise {
  const n = typeof rupees === "string" ? Number(rupees) : rupees;
  if (!Number.isFinite(n)) throw new Error(`Not a finite amount: ${rupees}`);
  return Math.round(n * 100) as Paise;
}

/** Parse a decimal-rupee string like "1299.00" into paise without float drift. */
export function paiseFromDecimal(decimal: string): Paise {
  const m = /^-?\d+(\.\d{1,2})?$/.exec(decimal.trim());
  if (!m) throw new Error(`Malformed decimal amount: ${decimal}`);
  const neg = decimal.trim().startsWith("-");
  const [whole, frac = ""] = decimal.trim().replace("-", "").split(".");
  const total = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return (neg ? -total : total) as Paise;
}

export function add(a: Paise, b: Paise): Paise {
  return (a + b) as Paise;
}

export function sub(a: Paise, b: Paise): Paise {
  return (a - b) as Paise;
}

export function mulQty(a: Paise, qty: number): Paise {
  if (!Number.isInteger(qty) || qty < 0) throw new Error(`Bad quantity: ${qty}`);
  return (a * qty) as Paise;
}

/**
 * Apply a percentage, rounding half-up to the nearest paisa.
 * `bps` is basis points: 1250 bps = 12.50%. Integers in, integer out.
 */
export function applyBps(a: Paise, bps: number): Paise {
  return Math.round((a * bps) / 10_000) as Paise;
}

/** Format paise for humans: 199900 -> "₹1,999.00" */
export function format(a: Paise): string {
  const neg = a < 0;
  const abs = Math.abs(a);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const grouped = rupees.toLocaleString("en-IN");
  return `${neg ? "-" : ""}₹${grouped}.${String(p).padStart(2, "0")}`;
}

/** Safe for logs and JSON: the raw integer. */
export function toInt(a: Paise): number {
  return a;
}
