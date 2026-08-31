import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "./config";
import { AuditLedger } from "./governance/ledger";

let _db: Database.Database | null = null;
let _ledger: AuditLedger | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const instance = new Database(config.dbPath);
  // WAL lets the dashboard read while a run is appending to the ledger.
  instance.pragma("journal_mode = WAL");
  instance.pragma("foreign_keys = ON");
  migrate(instance);
  _db = instance;
  return instance;
}

export function ledger(): AuditLedger {
  if (!_ledger) _ledger = new AuditLedger(db());
  return _ledger;
}

function migrate(instance: Database.Database): void {
  instance.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT NOT NULL,
      category    TEXT NOT NULL,
      price       INTEGER NOT NULL,
      costFloor   INTEGER NOT NULL,
      stock       INTEGER NOT NULL,
      attributes  TEXT NOT NULL,
      tags        TEXT NOT NULL,
      shipsInDays INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mandates (
      id                TEXT PRIMARY KEY,
      principal         TEXT NOT NULL,
      purpose           TEXT NOT NULL,
      perTxnCap         INTEGER NOT NULL,
      totalCap          INTEGER NOT NULL,
      spent             INTEGER NOT NULL DEFAULT 0,
      categoryAllowlist TEXT NOT NULL,
      maxQtyPerLine     INTEGER NOT NULL,
      approvalAbove     INTEGER NOT NULL,
      currency          TEXT NOT NULL,
      expiresAt         TEXT NOT NULL,
      status            TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id               TEXT PRIMARY KEY,
      mandateId        TEXT NOT NULL,
      idempotencyKey   TEXT NOT NULL UNIQUE,
      lines            TEXT NOT NULL,
      subtotal         INTEGER NOT NULL,
      discount         INTEGER NOT NULL,
      shipping         INTEGER NOT NULL,
      total            INTEGER NOT NULL,
      status           TEXT NOT NULL,
      razorpayOrderId  TEXT,
      razorpayPaymentId TEXT,
      approval         TEXT,
      createdAt        TEXT NOT NULL,
      updatedAt        TEXT NOT NULL,
      history          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_rzp ON orders(razorpayOrderId);

    CREATE TABLE IF NOT EXISTS runs (
      id         TEXT PRIMARY KEY,
      mandateId  TEXT NOT NULL,
      intent     TEXT NOT NULL,
      steps      TEXT NOT NULL,
      outcome    TEXT NOT NULL,
      orderId    TEXT,
      startedAt  TEXT NOT NULL,
      finishedAt TEXT
    );

    -- Reconciliation attempts are tracked so retries are bounded and observable,
    -- not an unbounded loop hammering the payments API.
    CREATE TABLE IF NOT EXISTS reconciliation_attempts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      orderId    TEXT NOT NULL,
      attempt    INTEGER NOT NULL,
      outcome    TEXT NOT NULL,
      detail     TEXT NOT NULL,
      at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recon_order ON reconciliation_attempts(orderId);

    -- Append-only audit ledger. Every entry hash-chains to its predecessor, so
    -- editing or deleting history is detectable rather than merely disallowed.
    -- See src/governance/ledger.ts for the rules that govern it.
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

    -- Reserved stock. Released by the sweeper if payment never lands.
    CREATE TABLE IF NOT EXISTS reservations (
      id         TEXT PRIMARY KEY,
      orderId    TEXT NOT NULL,
      productId  TEXT NOT NULL,
      qty        INTEGER NOT NULL,
      createdAt  TEXT NOT NULL,
      releasedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_res_order ON reservations(orderId);
  `);
}

/** Used by tests and the demo to get a clean slate. */
export function resetDatabase(): void {
  const instance = db();
  instance.exec(`
    DELETE FROM ledger;
    DELETE FROM orders;
    DELETE FROM runs;
    DELETE FROM reconciliation_attempts;
    DELETE FROM reservations;
    DELETE FROM mandates;
    DELETE FROM products;
  `);
}
