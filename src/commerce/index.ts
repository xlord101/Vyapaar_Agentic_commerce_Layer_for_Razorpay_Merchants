import { razorpayEnabled } from "../config";
import type { PaymentGateway } from "./gateway";
import { RazorpayGateway } from "./razorpay";
import { PaymentSimulator } from "./simulator";

let _gateway: PaymentGateway | null = null;
let _simulator: PaymentSimulator | null = null;

/** The simulator is always instantiated; it doubles as the fault-injection rig. */
export function simulator(): PaymentSimulator {
  if (!_simulator) _simulator = new PaymentSimulator();
  return _simulator;
}

export function gateway(): PaymentGateway {
  if (!_gateway) {
    _gateway = razorpayEnabled() ? new RazorpayGateway() : simulator();
  }
  return _gateway;
}

export function gatewayMode(): string {
  return gateway().mode;
}

export * from "./gateway";
