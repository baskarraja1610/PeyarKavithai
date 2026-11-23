
import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });

export default async (request) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!secret) {
    console.error("RAZORPAY_WEBHOOK_SECRET is missing");
    return json({ error: "Webhook configuration missing" }, 500);
  }

  try {
    // IMPORTANT: Verify the original raw body before parsing JSON.
    const rawBody = await request.text();

    const signature = request.headers.get("x-razorpay-signature");

    if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) {
      return json({ error: "Invalid signature header" }, 400);
    }

    const expected = createHmac("sha256", secret)
      .update(rawBody, "utf8")
      .digest();

    const received = Buffer.from(signature, "hex");

    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      return json({ error: "Signature verification failed" }, 401);
    }

    // Parse only after signature verification.
    const payload = JSON.parse(rawBody);

    const event = payload.event || "unknown";
    const payment = payload.payload?.payment?.entity || {};
    const order = payload.payload?.order?.entity || {};

    const eventHeader = request.headers.get("x-razorpay-event-id");

    const eventId =
      eventHeader ||
      createHash("sha256").update(rawBody).digest("hex");

    // Store only the payment details needed for later processing.
    const record = {
      event_id: eventId,
      event,
      created_at: payload.created_at || null,
      order_id: payment.order_id || order.id || null,
      payment_id: payment.id || null,
      amount: payment.amount ?? order.amount ?? null,
      currency: payment.currency || order.currency || null,
      payment_status: payment.status || null,
      received_at: new Date().toISOString(),
      processing_status: "pending"
    };

    const store = getStore({
      name: "razorpay-webhook-inbox",
      region: "ap-southeast-1"
    });

    const saved = await store.setJSON(
      `event-${encodeURIComponent(eventId)}`,
      record,
      { onlyIfNew: true }
    );

    if (!saved.modified) {
      return json({ received: true, duplicate: true });
    }

    console.log("Razorpay event safely stored:", event);

    return json({ received: true, stored: true });

  } catch (error) {
    console.error("Webhook processing error:", error.message);

    // Non-2xx response lets Razorpay retry delivery.
    return json({ error: "Webhook processing failed" }, 500);
  }
};

