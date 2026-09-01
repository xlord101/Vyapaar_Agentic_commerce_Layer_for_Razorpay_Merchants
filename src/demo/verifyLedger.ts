/**
 * Verify the audit ledger chain.
 *
 * `npm run verify:ledger` recomputes every hash from genesis and reports
 * whether the chain is intact. It exits non-zero when the chain is broken, so
 * it can be run as a one-off check or wired into CI.
 *
 * Tamper-evidence is the whole point of the ledger, so this is the one command
 * anyone can run to check the claim without reading any code.
 */

import { db, ledger } from "../db";

function main(): number {
  console.log(`\n\x1b[1mVyapaar — audit ledger verification\x1b[0m\n`);

  const { n } = db().prepare(`SELECT COUNT(*) AS n FROM ledger`).get() as { n: number };

  if (n === 0) {
    console.log(`  \x1b[90mLedger is empty — nothing to verify yet.\x1b[0m`);
    console.log(`  \x1b[90mRun \`npm run demo\` first, then run this again.\x1b[0m\n`);
    return 0;
  }

  const result = ledger().verify();

  if (result.ok) {
    console.log(`  \x1b[32m✓\x1b[0m Chain intact across ${result.entries} entries.`);
  } else {
    console.log(`  \x1b[31m✗\x1b[0m Chain BROKEN at entry ${result.brokenAtSeq}.`);
    console.log(`    \x1b[31m${result.reason}\x1b[0m`);
  }

  const counts = db()
    .prepare(`SELECT action, COUNT(*) AS n FROM ledger GROUP BY action ORDER BY n DESC, action ASC`)
    .all() as Array<{ action: string; n: number }>;

  if (counts.length > 0) {
    console.log(`\n  \x1b[1mActions recorded\x1b[0m`);
    const width = Math.max(...counts.map((c) => c.action.length));
    for (const c of counts) {
      console.log(`    \x1b[90m${c.action.padEnd(width)}  ×${c.n}\x1b[0m`);
    }
  }

  console.log("");
  return result.ok ? 0 : 1;
}

process.exit(main());
