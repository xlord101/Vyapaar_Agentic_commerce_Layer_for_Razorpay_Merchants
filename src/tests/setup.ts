/**
 * Imported first by the test suite, before anything that touches the database
 * or reads configuration.
 *
 * Config snapshots these values when `../config` and `../db` are first loaded,
 * so they have to be set before that happens. Relying on the caller to prefix
 * environment variables would break on Windows cmd, where `DB_PATH=x cmd` is
 * not valid syntax.
 *
 * The suite must be hermetic: identical results whether or not the machine has
 * real credentials in .env. Without the two FORCE flags below, a machine with
 * Razorpay test keys creates orders on the real Razorpay API while the test
 * helpers settle them through the simulator — the gateway then answers "No such
 * order", and five reconciliation tests fail for reasons that have nothing to
 * do with the code under test.
 */

import * as path from "node:path";
import * as fs from "node:fs";

const testDb = path.resolve(process.cwd(), "data", "test.db");

process.env.DB_PATH = testDb;

// Deterministic modes, regardless of what .env contains.
process.env.RAZORPAY_FORCE_SIMULATOR = "true";
process.env.LLM_FORCE_HEURISTIC = "true";

// Start from a clean file every run.
for (const suffix of ["", "-wal", "-shm"]) {
  const f = testDb + suffix;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
