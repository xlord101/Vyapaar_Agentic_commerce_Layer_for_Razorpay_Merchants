import { db } from "../db";
import * as M from "../domain/money";
import type { Product } from "../domain/types";

export class CatalogRepository {
  upsert(product: Product): void {
    db()
      .prepare(
        `INSERT INTO products (id, title, description, category, price, costFloor, stock, attributes, tags, shipsInDays)
         VALUES (@id, @title, @description, @category, @price, @costFloor, @stock, @attributes, @tags, @shipsInDays)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, description=excluded.description, category=excluded.category,
           price=excluded.price, costFloor=excluded.costFloor, stock=excluded.stock,
           attributes=excluded.attributes, tags=excluded.tags, shipsInDays=excluded.shipsInDays`,
      )
      .run({
        id: product.id,
        title: product.title,
        description: product.description,
        category: product.category,
        price: M.toInt(product.price),
        costFloor: M.toInt(product.costFloor),
        stock: product.stock,
        attributes: JSON.stringify(product.attributes),
        tags: JSON.stringify(product.tags),
        shipsInDays: product.shipsInDays,
      });
  }

  all(): Product[] {
    return (db().prepare(`SELECT * FROM products ORDER BY category, price ASC`).all() as Array<
      Record<string, unknown>
    >).map(rowToProduct);
  }

  byId(id: string): Product | undefined {
    const row = db().prepare(`SELECT * FROM products WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToProduct(row) : undefined;
  }

  /**
   * Structured search for the agent. Deliberately not semantic — an AI buyer
   * that needs vector search to find a chair is solving the wrong problem.
   * It filters on typed constraints and tells you exactly what matched.
   */
  search(q: {
    terms?: string[];
    category?: string;
    maxUnitPrice?: M.Paise;
    maxShipsInDays?: number;
    attributeFilters?: Record<string, string | number | boolean>;
    inStockOnly?: boolean;
  }): Array<Product & { matchScore: number; matchedOn: string[] }> {
    const all = this.all();
    const results: Array<Product & { matchScore: number; matchedOn: string[] }> = [];

    for (const p of all) {
      const matchedOn: string[] = [];
      let score = 0;

      if (q.category && p.category !== q.category) continue;
      if (q.category) {
        matchedOn.push(`category=${p.category}`);
        score += 3;
      }

      if (q.maxUnitPrice !== undefined && p.price > q.maxUnitPrice) continue;
      if (q.maxUnitPrice !== undefined) {
        matchedOn.push(`price<=${M.format(q.maxUnitPrice)}`);
        score += 2;
      }

      if (q.maxShipsInDays !== undefined && p.shipsInDays > q.maxShipsInDays) continue;
      if (q.maxShipsInDays !== undefined) {
        matchedOn.push(`ships<=${q.maxShipsInDays}d`);
        score += 2;
      }

      if (q.inStockOnly !== false && p.stock <= 0) continue;

      let attrOk = true;
      for (const [k, v] of Object.entries(q.attributeFilters ?? {})) {
        if (String(p.attributes[k]) !== String(v)) {
          attrOk = false;
          break;
        }
        matchedOn.push(`${k}=${v}`);
        score += 2;
      }
      if (!attrOk) continue;

      const haystack = `${p.title} ${p.description} ${p.tags.join(" ")}`.toLowerCase();
      for (const term of q.terms ?? []) {
        if (haystack.includes(term.toLowerCase())) {
          matchedOn.push(`term:"${term}"`);
          score += 1;
        }
      }

      if ((q.terms ?? []).length > 0 && score <= 2) continue;

      results.push({ ...p, matchScore: score, matchedOn });
    }

    return results.sort((a, b) => b.matchScore - a.matchScore || a.price - b.price);
  }

  /**
   * Atomically decrement stock, or refuse.
   * Returns false rather than going negative — overselling is the classic
   * agentic-commerce failure and it must be impossible, not merely unlikely.
   */
  reserve(productId: string, qty: number): boolean {
    const res = db()
      .prepare(`UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?`)
      .run(qty, productId, qty);
    return res.changes > 0;
  }

  release(productId: string, qty: number): void {
    db().prepare(`UPDATE products SET stock = stock + ? WHERE id = ?`).run(qty, productId);
  }

  count(): number {
    const row = db().prepare(`SELECT COUNT(*) AS n FROM products`).get() as { n: number };
    return row.n;
  }
}

export function rowToProduct(row: Record<string, unknown>): Product {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    category: String(row.category),
    price: Number(row.price) as M.Paise,
    costFloor: Number(row.costFloor) as M.Paise,
    stock: Number(row.stock),
    attributes: JSON.parse(String(row.attributes)) as Record<string, string | number | boolean>,
    tags: JSON.parse(String(row.tags)) as string[],
    shipsInDays: Number(row.shipsInDays),
  };
}
