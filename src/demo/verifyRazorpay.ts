/**
 * Verify the real Razorpay test-mode adapter.
 *
 * `npm run verify:razorpay`
 *
 * With no keys configured this does nothing and exits 0 — running on the
 * simulator is a supported mode, not an error. With test keys present it
 * exercises the API calls the adapter actually makes, and checks the one
 * property that is easy to get wrong and catastrophic to get wrong: **the
 * amount round-trip**. Razorpay speaks paise. Sending rupees creates an order
 * for one hundredth of the intended price, and nothing downstream will catch it.
 *
 * It deliberately does NOT try to capture a payment. In test mode that needs a
 * hosted checkout or a manually entered test instrument, and an agent can drive
 * neither. That limitation is why the fault-injection demo stays on the
 * simulator even with real credentials loaded.
 *
 * It also deliberately bypasses RAZORPAY_FORCE_SIMULATOR. That flag exists so
 * `npm run demo` keeps its fault-injection steps; this script is explicitly
 * asking whether the real adapter works, so the flag must not silence it.
 */

import { RazorpayGateway } from "../commerce/razorpay";
import { config } from "../config";
import * as M from "../domain/money";

function ok(s: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${s}`);
}
function bad(s: string) {
  console.log(`  \x1b[31m✗\x1b[0m ${s}`);
}
function info(s: string) {
  console.log(`    \x1b[90m${s}\x1b[0m`);
}

async function main(): Promise<number> {
  console.log(`\n\x1b[1mVyapaar — Razorpay adapter verification\x1b[0m\n`);

  const hasKeys = Boolean(config.razorpay.keyId && config.razorpay.keySecret);

  if (!hasKeys) {
    console.log(`  \x1b[90mNo Razorpay test keys configured — nothing to verify.\x1b[0m`);
    console.log(`  \x1b[90mThe project runs fine on the built-in simulator.\x1b[0m`);
    console.log(`  \x1b[90mTo verify against the real API, add keys to .env and re-run.\x1b[0m\n`);
    return 0;
  }

  // Deliberately construct the real adapter directly rather than going through
  // gateway(). RAZORPAY_FORCE_SIMULATOR exists so the demo keeps its
  // fault-injection steps; this script is explicitly asking "does the real
  // adapter work", so forceSimulator must not silence it.
  const g = new RazorpayGateway();
  if (config.razorpay.forceSimulator) {
    console.log(`  \x1b[90mNote: RAZORPAY_FORCE_SIMULATOR is set; ignoring it for this check.\x1b[0m`);
  }
  console.log(`  mode: ${g.mode} (real Razorpay test-mode API)\n`);

  // ₹199.00 = 19900 paise. Note `M.paise()` takes RUPEES and multiplies by 100,
  // so `M.paise(19900)` would be ₹19,900 — the exact slip this check exists to
  // catch. `paiseFromDecimal` is used here because it never touches a float.
  // The amount is deliberately not a round rupee figure either.
  const amount = M.paiseFromDecimal("199.00");
  const receipt = `vyapaar-verify-${Date.now()}`.slice(0, 40);

  let failures = 0;
  let orderId = "";

  try {
    const order = await g.createOrder({
      amount,
      receipt,
      notes: { purpose: "vyapaar-adapter-verification" },
    });
    orderId = order.id;

    if (M.toInt(order.amount) === M.toInt(amount)) {
      ok(`createOrder — ${order.id}, ${M.format(order.amount)}`);
    } else {
      bad(`createOrder amount mismatch: sent ${M.toInt(amount)} paise, got ${M.toInt(order.amount)}`);
      failures++;
    }
    info(`receipt "${order.receipt}" · status ${order.status}`);
  } catch (err) {
    bad(`createOrder failed: ${(err as Error).message}`);
    console.log("");
    return 1;
  }

  try {
    const fetched = await g.fetchOrder(orderId);
    if (!fetched) {
      bad(`fetchOrder returned null for ${orderId}`);
      failures++;
    } else if (M.toInt(fetched.amount) === M.toInt(amount)) {
      ok(`fetchOrder — amount round-trips exactly (${M.toInt(fetched.amount)} paise)`);
    } else {
      bad(`fetchOrder amount drift: sent ${M.toInt(amount)}, got ${M.toInt(fetched.amount)}`);
      failures++;
    }
  } catch (err) {
    bad(`fetchOrder failed: ${(err as Error).message}`);
    failures++;
  }

  try {
    const payments = await g.fetchPaymentsForOrder(orderId);
    ok(`fetchPaymentsForOrder — reachable, ${payments.length} payment(s) on this order`);
    info("This is the exact call reconciliation makes when a webhook never arrives.");
  } catch (err) {
    bad(`fetchPaymentsForOrder failed: ${(err as Error).message}`);
    failures++;
  }

  console.log("");
  if (failures === 0) {
    console.log(`  \x1b[32mAdapter verified against live Razorpay test mode.\x1b[0m`);
    console.log("");
    info("Not covered: refund (no captured payment to refund) and payment capture");
    info("itself, which needs a hosted checkout or a manual test instrument.");
    info("Webhook recovery therefore stays on the simulator by design.");
    console.log("");
    return 0;
  }

  console.log(`  \x1b[31m${failures} check(s) failed.\x1b[0m\n`);
  return 1;
}

main().then((code) => process.exit(code));
