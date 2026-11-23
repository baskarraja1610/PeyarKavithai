import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

const REGION = "ap-southeast-1";
const AMOUNT = 1430;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8" }
});

async function markOrderPaid(orderId, paymentId) {
  if (!orderId) return;
  const orders = getStore({ name: "peyarkavithai-orders", region: REGION });
  const key = `order-${orderId}`;
  for (let i = 0; i < 4; i++) {
    const current = await orders.getWithMetadata(key, { type: "json", consistency: "strong" });
    if (!current) return;
    if (current.data.status === "paid" || current.data.status === "delivered") return;
    const next = { ...current.data, status: "paid", payment_id: paymentId || current.data.payment_id || null, paid_at: current.data.paid_at || new Date().toISOString() };
    const saved = await orders.setJSON(key, next, { onlyIfMatch: current.etag });
    if (saved.modified) return;
  }
  throw new Error("order_update_conflict");
}

export default async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("RAZORPAY_WEBHOOK_SECRET is missing");
    return json({ error: "Webhook configuration missing" }, 500);
  }

  try {
    const rawBody = await request.text();
    const signature = request.headers.get("x-razorpay-signature");
    if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return json({ error: "Invalid signature header" }, 400);
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
    const received = Buffer.from(signature, "hex");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return json({ error: "Signature verification failed" }, 401);

    const payload = JSON.parse(rawBody);
    const event = payload.event || "unknown";
    const payment = payload.payload?.payment?.entity || {};
    const order = payload.payload?.order?.entity || {};
    const eventId = request.headers.get("x-razorpay-event-id") || createHash("sha256").update(rawBody).digest("hex");
    const orderId = payment.order_id || order.id || null;
    const amount = payment.amount ?? order.amount_paid ?? order.amount ?? null;
    const currency = payment.currency || order.currency || null;

    if (event === "payment.captured" && payment.status === "captured" && amount === AMOUNT && currency === "INR") {
      await markOrderPaid(orderId, payment.id);
    } else if (event === "order.paid" && order.status === "paid" && amount === AMOUNT && currency === "INR") {
      await markOrderPaid(orderId, payment.id || null);
    }

    const inbox = getStore({ name: "razorpay-webhook-inbox", region: REGION });
    const record = {
      event_id: eventId, event, created_at: payload.created_at || null,
      order_id: orderId, payment_id: payment.id || null, amount, currency,
      payment_status: payment.status || order.status || null,
      received_at: new Date().toISOString(), processing_status: "received"
    };
    const saved = await inbox.setJSON(`event-${encodeURIComponent(eventId)}`, record, { onlyIfNew: true });
    if (!saved.modified) return json({ received: true, duplicate: true });
    console.log("Razorpay webhook received:", event);
    return json({ received: true, stored: true });
  } catch (error) {
    console.error("Webhook processing error:", error.message);
    return json({ error: "Webhook processing failed" }, 500);
  }
};
