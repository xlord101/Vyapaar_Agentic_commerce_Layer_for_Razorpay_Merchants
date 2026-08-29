import { randomUUID } from "node:crypto";
import { db, ledger } from "../db";
import * as M from "../domain/money";
import type { Mandate } from "../domain/types";

/**
 * Mandates are the delegation of spending authority. Creating one is itself an
 * audited act: we record who granted what, to whom, and under which caps.
 */

export interface CreateMandateInput {
  principal: string;
  purpose: string;
  perTxnCap: M.Paise;
  totalCap: M.Paise;
  categoryAllowlist?: string[];
  maxQtyPerLine?: number;
  approvalAbove: M.Paise;
  /** Validity in hours from now. */
  validHours?: number;
}

export class MandateStore {
  create(input: CreateMandateInput): Mandate {
    const id = `mnd_${randomUUID().slice(0, 12)}`;
    const expiresAt = new Date(Date.now() + (input.validHours ?? 72) * 3600_000).toISOString();

    const mandate: Mandate = {
      id,
      principal: input.principal,
      purpose: input.purpose,
      perTxnCap: input.perTxnCap,
      totalCap: input.totalCap,
      spent: M.paise(0),
      categoryAllowlist: input.categoryAllowlist ?? [],
      maxQtyPerLine: input.maxQtyPerLine ?? 5,
      approvalAbove: input.approvalAbove,
      currency: "INR",
      expiresAt,
      status: "active",
    };

    db()
      .prepare(
        `INSERT INTO mandates (id, principal, purpose, perTxnCap, totalCap, spent, categoryAllowlist, maxQtyPerLine, approvalAbove, currency, expiresAt, status)
         VALUES (@id, @principal, @purpose, @perTxnCap, @totalCap, @spent, @categoryAllowlist, @maxQtyPerLine, @approvalAbove, @currency, @expiresAt, @status)`,
      )
      .run({
        id: mandate.id,
        principal: mandate.principal,
        purpose: mandate.purpose,
        perTxnCap: M.toInt(mandate.perTxnCap),
        totalCap: M.toInt(mandate.totalCap),
        spent: M.toInt(mandate.spent),
        categoryAllowlist: JSON.stringify(mandate.categoryAllowlist),
        maxQtyPerLine: mandate.maxQtyPerLine,
        approvalAbove: M.toInt(mandate.approvalAbove),
        currency: mandate.currency,
        expiresAt: mandate.expiresAt,
        status: mandate.status,
      });

    ledger().append({
      action: "mandate.issued",
      actor: { kind: "human", id: input.principal },
      mandateId: id,
      payload: {
        purpose: mandate.purpose,
        perTxnCap: M.toInt(mandate.perTxnCap),
        totalCap: M.toInt(mandate.totalCap),
        approvalAbove: M.toInt(mandate.approvalAbove),
        categoryAllowlist: mandate.categoryAllowlist,
        maxQtyPerLine: mandate.maxQtyPerLine,
        expiresAt: mandate.expiresAt,
      },
    });

    return mandate;
  }

  byId(id: string): Mandate | undefined {
    const row = db().prepare(`SELECT * FROM mandates WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToMandate(row) : undefined;
  }

  list(): Mandate[] {
    const rows = db().prepare(`SELECT * FROM mandates ORDER BY rowid DESC`).all() as Array<Record<string, unknown>>;
    return rows.map(rowToMandate);
  }

  revoke(id: string, by: string): Mandate {
    db().prepare(`UPDATE mandates SET status = 'revoked' WHERE id = ?`).run(id);
    ledger().append({
      action: "mandate.revoked",
      actor: { kind: "human", id: by },
      mandateId: id,
      payload: { note: "Revoked by principal. All in-flight authority is void." },
    });
    return this.byId(id)!;
  }
}

export function rowToMandate(row: Record<string, unknown>): Mandate {
  return {
    id: String(row.id),
    principal: String(row.principal),
    purpose: String(row.purpose),
    perTxnCap: Number(row.perTxnCap) as M.Paise,
    totalCap: Number(row.totalCap) as M.Paise,
    spent: Number(row.spent) as M.Paise,
    categoryAllowlist: JSON.parse(String(row.categoryAllowlist)) as string[],
    maxQtyPerLine: Number(row.maxQtyPerLine),
    approvalAbove: Number(row.approvalAbove) as M.Paise,
    currency: "INR",
    expiresAt: String(row.expiresAt),
    status: row.status as Mandate["status"],
  };
}
