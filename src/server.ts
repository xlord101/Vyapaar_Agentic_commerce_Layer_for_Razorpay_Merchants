import express from "express";
import * as path from "node:path";
import { config, modeSummary } from "./config";
import { db, ledger } from "./db";
import { seedCatalog } from "./catalog/seed";
import { CatalogRepository } from "./catalog/repository";
import { router, webhookRouter } from "./api/routes";
import { OrderStore } from "./commerce/orders";

const app = express();

// The webhook route MUST receive the raw body. Mounting it before the JSON
// parser is the whole point — a re-serialised body breaks HMAC verification.
app.use(webhookRouter);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(router);
app.use(express.static(path.resolve(process.cwd(), "public")));

/* ------------------------------------------------------------------ *
 * Background sweeper
 *
 * Reconciles any order that is not in a terminal state. This is what turns a
 * lost webhook from a stuck order into a recovered one without anyone
 * noticing. Bounded: each reconcile() increments an attempt counter and
 * escalates after the cap rather than retrying forever.
 * ------------------------------------------------------------------ */

const orders = new OrderStore();

function sweep(): void {
  try {
    const stuck = orders.list({ tail: 200 }).filter(
      (o) =>
        o.razorpayOrderId &&
        o.status !== "paid" &&
        o.status !== "refunded" &&
        o.status !== "abandoned" &&
        o.status !== "failed",
    );
    for (const order of stuck) {
      orders
        .reconcile(order.id, { reason: "sweeper" })
        .then((r) => {
          if (r.status === "recovered" || r.status === "abandoned" || r.status === "escalated") {
            console.log(`[sweeper] ${order.id} -> ${r.status} (${r.detail})`);
          }
        })
        .catch((err: Error) => console.error(`[sweeper] ${order.id} error: ${err.message}`));
    }
  } catch (err) {
    console.error(`[sweeper] ${(err as Error).message}`);
  }
}

/* ------------------------------------------------------------------ */

function bootstrap(): void {
  if (new CatalogRepository().count() === 0) {
    const n = seedCatalog();
    console.log(`Seeded catalog with ${n} products.`);
  }

  app.listen(config.port, () => {
    const mode = modeSummary();
    console.log("");
    console.log("  Vyapaar — agentic commerce layer");
    console.log("  ────────────────────────────────────────────");
    console.log(`  dashboard      http://localhost:${config.port}`);
    console.log(`  agent manifest http://localhost:${config.port}/.well-known/agent-commerce.json`);
    console.log(`  catalog feed   http://localhost:${config.port}/api/v1/feed/products`);
    console.log(`  llms.txt       http://localhost:${config.port}/llms.txt`);
    console.log("");
    console.log(`  payments       ${mode.payments}`);
    console.log(`  intent parsing ${mode.intentParsing}`);
    console.log("");
    const v = ledger().verify();
    console.log(`  audit ledger   ${v.entries} entries, chain ${v.ok ? "intact" : "BROKEN"}`);
    console.log("");
  });

  setInterval(sweep, 30_000).unref();
}

// Keep the DB handle warm so WAL files are created on boot, not mid-request.
void db();

bootstrap();

export { app };
