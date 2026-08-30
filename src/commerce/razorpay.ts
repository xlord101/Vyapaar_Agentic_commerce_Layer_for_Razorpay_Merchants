import { createHmac, timingSafeEqual } from "node:crypto";
import Razorpay from "razorpay";
import * as M from "../domain/money";
import { config } from "../config";
import {
  GatewayError,
  type CreateOrderInput,
  type GatewayMode,
  type GatewayOrder,
  type GatewayOrderStatus,
  type GatewayPayment,
  type GatewayRefund,
  type PaymentGateway,
} from "./gateway";

/**
 * Razorpay test mode.
 *
 * Two things this file is careful about, both learned the hard way:
 *
 * 1. Amounts are paise. Razorpay wants the smallest currency unit and will
 *    happily create a ₹18,499 order for "18499" that you meant as rupees. Every
 *    amount going out is an integer from the money module, never a float.
 *
 * 2. Webhook verification is a constant-time comparison against a raw body.
 *    Re-serialising the parsed JSON before checking the signature is the classic
 *    way to "verify" a webhook that verifies nothing.
 */

export class RazorpayGateway implements PaymentGateway {
  readonly mode: GatewayMode = "razorpay-test";
  private client: Razorpay;

  constructor() {
    this.client = new Razorpay({
      key_id: config.razorpay.keyId,
      key_secret: config.razorpay.keySecret,
    });
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    try {
      const created = (await this.client.orders.create({
        amount: M.toInt(input.amount),
        currency: "INR",
        receipt: input.receipt.slice(0, 40), // Razorpay caps receipt at 40 chars
        notes: input.notes ?? {},
      })) as unknown as RazorpayOrderResponse;

      return {
        id: created.id,
        amount: Number(created.amount) as M.Paise,
        currency: "INR",
        receipt: created.receipt ?? input.receipt,
        status: mapStatus(created.status),
        notes: (created.notes ?? {}) as Record<string, string>,
        createdAt: (created.created_at ?? Date.now() / 1000) * 1000,
      };
    } catch (err) {
      throw toGatewayError(err, "createOrder");
    }
  }

  async fetchOrder(orderId: string): Promise<GatewayOrder | null> {
    try {
      const fetched = (await this.client.orders.fetch(orderId)) as unknown as RazorpayOrderResponse;
      return {
        id: fetched.id,
        amount: Number(fetched.amount) as M.Paise,
        currency: "INR",
        receipt: fetched.receipt ?? "",
        status: mapStatus(fetched.status),
        notes: (fetched.notes ?? {}) as Record<string, string>,
        createdAt: (fetched.created_at ?? Date.now() / 1000) * 1000,
      };
    } catch (err) {
      const ge = toGatewayError(err, "fetchOrder");
      if (ge.code === "NOT_FOUND") return null;
      throw ge;
    }
  }

  /**
   * The reconciliation primitive. When a webhook never arrives, this is the
   * source of truth — not our own order row, which is exactly what we distrust.
   */
  async fetchPaymentsForOrder(orderId: string): Promise<GatewayPayment[]> {
    try {
      const res = (await this.client.orders.fetchPayments(orderId)) as unknown as {
        items?: RazorpayPaymentResponse[];
      };
      return (res.items ?? []).map((p) => ({
        id: p.id,
        orderId: p.order_id ?? orderId,
        amount: Number(p.amount) as M.Paise,
        status: mapPaymentStatus(p.status),
        method: p.method ?? "unknown",
        capturedAt: p.captured ? (p.created_at ?? Date.now() / 1000) * 1000 : undefined,
        errorCode: p.error_code,
        errorDescription: p.error_description,
      }));
    } catch (err) {
      const ge = toGatewayError(err, "fetchPaymentsForOrder");
      if (ge.code === "NOT_FOUND") return [];
      throw ge;
    }
  }

  async refund(paymentId: string, amount: M.Paise, reason?: string): Promise<GatewayRefund> {
    try {
      const res = (await this.client.payments.refund(paymentId, {
        amount: M.toInt(amount),
        ...(reason ? { notes: { reason } } : {}),
      })) as unknown as { id: string; status?: string };
      return {
        id: res.id,
        paymentId,
        amount,
        status: res.status === "failed" ? "failed" : "processed",
      };
    } catch (err) {
      throw toGatewayError(err, "refund");
    }
  }

  /**
   * Verify the HMAC over the RAW request body.
   * Body parser must give us the untouched bytes; see the raw-body middleware.
   */
  verifyWebhookSignature(rawBody: string | Buffer, signature: string | undefined): boolean {
    if (!signature || !config.razorpay.webhookSecret) return false;
    const expected = createHmac("sha256", config.razorpay.webhookSecret).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

interface RazorpayOrderResponse {
  id: string;
  amount: number;
  receipt?: string;
  status?: string;
  notes?: unknown;
  created_at?: number;
}

interface RazorpayPaymentResponse {
  id: string;
  order_id?: string;
  amount: number;
  status?: string;
  method?: string;
  captured?: boolean;
  created_at?: number;
  error_code?: string;
  error_description?: string;
}

function mapStatus(s: string | undefined): GatewayOrderStatus {
  switch (s) {
    case "created":
      return "created";
    case "attempted":
      return "attempted";
    case "paid":
      return "paid";
    default:
      return "created";
  }
}

function mapPaymentStatus(s: string | undefined): GatewayPayment["status"] {
  switch (s) {
    case "captured":
      return "captured";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

function toGatewayError(err: unknown, op: string): GatewayError {
  const e = err as { statusCode?: number; error?: { code?: string; description?: string }; message?: string };
  const status = e?.statusCode ?? 0;
  const description = e?.error?.description ?? e?.message ?? "unknown error";

  if (status === 400 && /not found/i.test(description)) {
    return new GatewayError(`${op}: not found (${description})`, "NOT_FOUND", false);
  }
  if (status === 401) {
    return new GatewayError(`${op}: authentication failed — check RAZORPAY_KEY_ID/SECRET`, "AUTH_ERROR", false);
  }
  if (status === 429 || status >= 500) {
    return new GatewayError(`${op}: ${description}`, "TRANSIENT", true);
  }
  return new GatewayError(`${op}: ${description}`, "GATEWAY_ERROR", false);
}
