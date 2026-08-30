import type { Paise } from "../domain/money";

/**
 * One interface, two implementations: the real Razorpay test-mode SDK and an
 * in-memory simulator.
 *
 * The simulator is not a stub we hid because we lacked keys. It is the fault
 * injection harness. The interesting failures in agentic payments — a webhook
 * that never arrives, a payment that succeeds but whose confirmation is lost,
 * a client that retries and double-charges — are non-deterministic in
 * production and effectively untestable against a live gateway. Here they are
 * switches.
 */

export type GatewayMode = "razorpay-test" | "simulator";

export type GatewayOrderStatus = "created" | "attempted" | "paid" | "expired";

export interface GatewayOrder {
  id: string;
  amount: Paise;
  currency: "INR";
  receipt: string;
  status: GatewayOrderStatus;
  notes: Record<string, string>;
  createdAt: number;
}

export interface GatewayPayment {
  id: string;
  orderId: string;
  amount: Paise;
  status: "captured" | "failed" | "pending";
  method: string;
  capturedAt?: number;
  errorCode?: string;
  errorDescription?: string;
}

export interface GatewayRefund {
  id: string;
  paymentId: string;
  amount: Paise;
  status: "processed" | "failed";
}

export interface CreateOrderInput {
  amount: Paise;
  receipt: string;
  notes?: Record<string, string>;
}

export interface PaymentGateway {
  readonly mode: GatewayMode;
  createOrder(input: CreateOrderInput): Promise<GatewayOrder>;
  fetchOrder(orderId: string): Promise<GatewayOrder | null>;
  fetchPaymentsForOrder(orderId: string): Promise<GatewayPayment[]>;
  refund(paymentId: string, amount: Paise, reason?: string): Promise<GatewayRefund>;
  verifyWebhookSignature(rawBody: string | Buffer, signature: string | undefined): boolean;
}

/* ------------------------------------------------------------------ *
 * Fault injection — simulator only
 * ------------------------------------------------------------------ */

export interface FaultConfig {
  /** Webhook for the next successful payment is silently dropped. */
  dropNextWebhook: boolean;
  /** createOrder throws, as if the network died mid-call. */
  failCreateOrder: boolean;
  /** Payment is captured at the gateway but the API call to create it times out. */
  timeoutCreateOrder: boolean;
  /** Payment attempt fails at the gateway. */
  failPayment: boolean;
  /** Payment sits in pending forever (UPI collect style). */
  leavePaymentPending: boolean;
}

export const NO_FAULTS: FaultConfig = {
  dropNextWebhook: false,
  failCreateOrder: false,
  timeoutCreateOrder: false,
  failPayment: false,
  leavePaymentPending: false,
};

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
