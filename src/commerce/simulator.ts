import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import * as M from "../domain/money";
import {
  GatewayError,
  NO_FAULTS,
  type CreateOrderInput,
  type FaultConfig,
  type GatewayMode,
  type GatewayOrder,
  type GatewayPayment,
  type GatewayRefund,
  type PaymentGateway,
} from "./gateway";

/**
 * An in-memory Razorpay that behaves like the real one where it matters:
 * server-side orders, idempotent receipts, webhooks with a real HMAC signature,
 * and payments that can succeed without the webhook ever reaching you. That
 * last case is the one that breaks naive integrations, so it is a switch here.
 */

const SIM_SECRET = "simulator-webhook-secret";

export class PaymentSimulator implements PaymentGateway {
  readonly mode: GatewayMode = "simulator";

  private orders = new Map<string, GatewayOrder>();
  private payments = new Map<string, GatewayPayment>();
  private paymentsByOrder = new Map<string, string[]>();
  private receiptIndex = new Map<string, string>();
  faults: FaultConfig = { ...NO_FAULTS };

  /** Webhooks the simulator "sent". Empty when dropNextWebhook swallowed one. */
  readonly webhookOutbox: Array<{ event: string; payload: unknown }> = [];

  setFaults(next: Partial<FaultConfig>): FaultConfig {
    this.faults = { ...this.faults, ...next };
    return this.faults;
  }

  clearFaults(): FaultConfig {
    this.faults = { ...NO_FAULTS };
    return this.faults;
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    if (this.faults.failCreateOrder) {
      throw new GatewayError("Simulated network failure on createOrder", "NETWORK_ERROR", true);
    }
    if (this.faults.timeoutCreateOrder) {
      throw new GatewayError("Simulated gateway timeout on createOrder", "GATEWAY_TIMEOUT", true);
    }

    // Idempotency by receipt, exactly as Razorpay behaves: the same receipt
    // returns the same order rather than minting a second one.
    const existingId = this.receiptIndex.get(input.receipt);
    if (existingId) {
      const existing = this.orders.get(existingId);
      if (existing) return existing;
    }

    const id = `order_sim_${randomUUID().slice(0, 16)}`;
    const order: GatewayOrder = {
      id,
      amount: input.amount,
      currency: "INR",
      receipt: input.receipt,
      status: "created",
      notes: input.notes ?? {},
      createdAt: Date.now(),
    };
    this.orders.set(id, order);
    this.receiptIndex.set(input.receipt, id);
    return order;
  }

  /**
   * Stand-in for a buyer completing payment. In live mode this is a hosted
   * checkout or a UPI intent; here the caller just triggers it.
   */
  async completePayment(orderId: string, opts: { method?: string } = {}): Promise<GatewayPayment> {
    const order = this.orders.get(orderId);
    if (!order) throw new GatewayError(`No such order: ${orderId}`, "NOT_FOUND", false);

    if (this.faults.failPayment) {
      const payment: GatewayPayment = {
        id: `pay_sim_${randomUUID().slice(0, 16)}`,
        orderId,
        amount: order.amount,
        status: "failed",
        method: opts.method ?? "upi",
        errorCode: "BAD_REQUEST_ERROR",
        errorDescription: "Simulated payment failure",
      };
      this.payments.set(payment.id, payment);
      this.paymentsByOrder.set(orderId, [...(this.paymentsByOrder.get(orderId) ?? []), payment.id]);
      order.status = "attempted";
      this.emitWebhook("payment.failed", { payment });
      return payment;
    }

    const payment: GatewayPayment = {
      id: `pay_sim_${randomUUID().slice(0, 16)}`,
      orderId,
      amount: order.amount,
      status: this.faults.leavePaymentPending ? "pending" : "captured",
      method: opts.method ?? "upi",
      capturedAt: this.faults.leavePaymentPending ? undefined : Date.now(),
    };

    this.payments.set(payment.id, payment);
    this.paymentsByOrder.set(orderId, [...(this.paymentsByOrder.get(orderId) ?? []), payment.id]);
    order.status = payment.status === "captured" ? "paid" : "attempted";

    if (payment.status === "captured") {
      // THE failure this project is built to survive: the money moved, but the
      // notification does not. Order state and payment state diverge.
      if (this.faults.dropNextWebhook) {
        this.faults.dropNextWebhook = false;
        // Deliberately no webhook. Recovery must come from reconciliation.
      } else {
        this.emitWebhook("payment.captured", { payment, order });
      }
    }

    return payment;
  }

  async fetchOrder(orderId: string): Promise<GatewayOrder | null> {
    return this.orders.get(orderId) ?? null;
  }

  /** The reconciliation primitive: ask the gateway, not our own database. */
  async fetchPaymentsForOrder(orderId: string): Promise<GatewayPayment[]> {
    const ids = this.paymentsByOrder.get(orderId) ?? [];
    return ids.map((id) => this.payments.get(id)!).filter(Boolean);
  }

  async refund(paymentId: string, amount: M.Paise): Promise<GatewayRefund> {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new GatewayError(`No such payment: ${paymentId}`, "NOT_FOUND", false);
    const refund: GatewayRefund = {
      id: `rfnd_sim_${randomUUID().slice(0, 16)}`,
      paymentId,
      amount,
      status: "processed",
    };
    if (payment.status === "captured") payment.status = "failed"; // reversed
    return refund;
  }

  verifyWebhookSignature(rawBody: string | Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = createHmac("sha256", SIM_SECRET).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Sign a payload the way the simulator would when "sending" it. */
  signPayload(payload: unknown): string {
    return createHmac("sha256", SIM_SECRET).update(JSON.stringify(payload)).digest("hex");
  }

  private emitWebhook(event: string, payload: unknown): void {
    this.webhookOutbox.push({ event, payload });
  }

  /** Test/demo helper. */
  reset(): void {
    this.orders.clear();
    this.payments.clear();
    this.paymentsByOrder.clear();
    this.receiptIndex.clear();
    this.webhookOutbox.length = 0;
    this.faults = { ...NO_FAULTS };
  }
}
