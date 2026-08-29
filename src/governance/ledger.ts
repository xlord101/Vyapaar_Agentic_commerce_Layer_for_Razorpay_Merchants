import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";

/**
 * Tamper-evident, append-only audit ledger.
 *
 * Every money-relevant action lands here. Each entry commits to its predecessor
 * by hash, so editing or deleting any historical entry breaks verification for
 * everything after it. We do not merely log what happened — we make silent
 * retroactive edits detectable. That is the difference between a log and an
 * audit trail.
 *
 * There is deliberately no UPDATE and no DELETE on this table. Recovery from a
 * bad state happens by appending a correcting entry, never by rewriting history.
 */

export type LedgerActor =
  | { kind: "agent"; runId: string }
  | { kind: "human"; id: string }
  | { kind: "system"; component: string };

export interface LedgerEntry {
  seq: number;
  id: string;
  ts: string;
  action: string;
  actor: LedgerActor;
  mandateId: string | null;
  runId: string | null;
  orderId: string | null;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

/** Deterministic JSON: key order must not change the hash. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/**
 * Force a payload through a JSON round-trip before it is hashed or stored.
 *
 * This looks redundant and is not. A live object can hold values JSON cannot
 * represent — `undefined`, `NaN`, `Infinity`, functions. JSON.stringify drops
 * object keys whose value is `undefined`, so hashing the original object and
 * later re-hashing the stored-then-parsed copy produces two different strings
 * and a permanently "broken" chain. Normalising first guarantees that what we
 * hash is byte-identical to what we persist and read back.
 */
export function normalizePayload<T>(payload: T): T {
  if (payload === undefined || payload === null) return {} as T;
  return JSON.parse(JSON.stringify(payload)) as T;
}

export function computeHash(input: {
  prevHash: string;
  ts: string;
  action: string;
  actor: LedgerActor;
  mandateId: string | null;
  runId: string | null;
  orderId: string | null;
  payload: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(
      [
        input.prevHash,
        input.ts,
        input.action,
        canonical(input.actor),
        input.mandateId ?? "",
        input.runId ?? "",
        input.orderId ?? "",
        canonical(input.payload),
      ].join("|"),
    )
    .digest("hex");
}

const GENESIS = "0".repeat(64);

export class AuditLedger {
  constructor(private readonly db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        id        TEXT NOT NULL UNIQUE,
        ts        TEXT NOT NULL,
        action    TEXT NOT NULL,
        actor     TEXT NOT NULL,
        mandateId TEXT,
        runId     TEXT,
        orderId   TEXT,
        payload   TEXT NOT NULL,
        prevHash  TEXT NOT NULL,
        hash      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_run ON ledger(runId);
      CREATE INDEX IF NOT EXISTS idx_ledger_order ON ledger(orderId);
      CREATE INDEX IF NOT EXISTS idx_ledger_mandate ON ledger(mandateId);
    `);
  }

  /** Append an entry. This is the only mutating operation that exists. */
  append(input: {
    action: string;
    actor: LedgerActor;
    mandateId?: string | null;
    runId?: string | null;
    orderId?: string | null;
    payload?: Record<string, unknown>;
  }): LedgerEntry {
    const appendTx = this.db.transaction((): LedgerEntry => {
      // Read the tip inside the transaction so concurrent writers cannot
      // fork the chain.
      const tip = this.db
        .prepare(`SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1`)
        .get() as { hash: string } | undefined;
      const prevHash = tip?.hash ?? GENESIS;
      const ts = new Date().toISOString();
      // Normalise BEFORE hashing, and store this exact value.
      const payload = normalizePayload(input.payload ?? {});

      const hash = computeHash({
        prevHash,
        ts,
        action: input.action,
        actor: input.actor,
        mandateId: input.mandateId ?? null,
        runId: input.runId ?? null,
        orderId: input.orderId ?? null,
        payload,
      });

      const entry: LedgerEntry = {
        seq: -1,
        id: randomUUID(),
        ts,
        action: input.action,
        actor: input.actor,
        mandateId: input.mandateId ?? null,
        runId: input.runId ?? null,
        orderId: input.orderId ?? null,
        payload,
        prevHash,
        hash,
      };

      const info = this.db
        .prepare(
          `INSERT INTO ledger (id, ts, action, actor, mandateId, runId, orderId, payload, prevHash, hash)
           VALUES (@id, @ts, @action, @actor, @mandateId, @runId, @orderId, @payload, @prevHash, @hash)`,
        )
        .run({
          id: entry.id,
          ts: entry.ts,
          action: entry.action,
          actor: JSON.stringify(entry.actor),
          mandateId: entry.mandateId,
          runId: entry.runId,
          orderId: entry.orderId,
          payload: JSON.stringify(entry.payload),
          prevHash: entry.prevHash,
          hash: entry.hash,
        });

      entry.seq = Number(info.lastInsertRowid);
      return entry;
    });

    return appendTx();
  }

  /** Newest first. `tail` limits to the most recent N entries. */
  list(filter: { runId?: string; orderId?: string; mandateId?: string; tail?: number } = {}): LedgerEntry[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.runId) {
      clauses.push("runId = @runId");
      params.runId = filter.runId;
    }
    if (filter.orderId) {
      clauses.push("orderId = @orderId");
      params.orderId = filter.orderId;
    }
    if (filter.mandateId) {
      clauses.push("mandateId = @mandateId");
      params.mandateId = filter.mandateId;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.tail ? `LIMIT ${Number(filter.tail)}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM ledger ${where} ORDER BY seq DESC ${limit}`)
      .all(params) as Array<Record<string, unknown>>;
    return rows.map(rowToEntry).reverse();
  }

  /**
   * Recompute every hash from genesis forward.
   * Returns the first divergence, if any — that is the tamper signal.
   */
  verify(): { ok: boolean; entries: number; brokenAtSeq: number | null; reason?: string } {
    const rows = this.db.prepare(`SELECT * FROM ledger ORDER BY seq ASC`).all() as Array<
      Record<string, unknown>
    >;
    let prevHash = GENESIS;

    for (const row of rows) {
      const entry = rowToEntry(row);
      if (entry.prevHash !== prevHash) {
        return {
          ok: false,
          entries: rows.length,
          brokenAtSeq: entry.seq,
          reason: `Entry ${entry.seq} claims prevHash ${entry.prevHash.slice(0, 12)}… but the actual previous hash is ${prevHash.slice(0, 12)}…`,
        };
      }
      const recomputed = computeHash({
        prevHash: entry.prevHash,
        ts: entry.ts,
        action: entry.action,
        actor: entry.actor,
        mandateId: entry.mandateId,
        runId: entry.runId,
        orderId: entry.orderId,
        payload: entry.payload,
      });
      if (recomputed !== entry.hash) {
        return {
          ok: false,
          entries: rows.length,
          brokenAtSeq: entry.seq,
          reason: `Entry ${entry.seq} content does not match its recorded hash. The payload was altered after the fact.`,
        };
      }
      prevHash = entry.hash;
    }

    return { ok: true, entries: rows.length, brokenAtSeq: null };
  }
}

function rowToEntry(row: Record<string, unknown>): LedgerEntry {
  return {
    seq: Number(row.seq),
    id: String(row.id),
    ts: String(row.ts),
    action: String(row.action),
    actor: JSON.parse(String(row.actor)) as LedgerActor,
    mandateId: row.mandateId == null ? null : String(row.mandateId),
    runId: row.runId == null ? null : String(row.runId),
    orderId: row.orderId == null ? null : String(row.orderId),
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    prevHash: String(row.prevHash),
    hash: String(row.hash),
  };
}
