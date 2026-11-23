import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

const AMOUNT = 1430;
const REGION = "ap-southeast-1";
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function updateRecord(store, key, updater) {
  for (let i = 0; i < 4; i++) {
    const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    if (!current) return null;
    const next = updater(current.data);
    const saved = await store.setJSON(key, next, { onlyIfMatch: current.etag });
    if (saved.modified) return next;
  }
  throw new Error("order_update_conflict");
}

export default async (request) => {
  if (request.method !== "POST") return json({ error: "POST மட்டும் அனுமதிக்கப்படும்." }, 405);
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return json({ error: "Payment verification அமைக்கப்படவில்லை." }, 503);

  try {
    const body = await request.json();
    const orderId = String(body.razorpay_order_id || "");
    const paymentId = String(body.razorpay_payment_id || "");
    const signature = String(body.razorpay_signature || "");
    const accessToken = String(body.access_token || "");
    if (!/^order_[A-Za-z0-9]+$/.test(orderId) || !/^pay_[A-Za-z0-9]+$/.test(paymentId) || !/^[a-f0-9]{64}$/i.test(signature) || accessToken.length !== 64) {
      return json({ error: "Payment விவரங்கள் சரிபார்க்கப்படவில்லை." }, 400);
    }

    const store = getStore({ name: "peyarkavithai-orders", region: REGION });
    const key = `order-${orderId}`;
    const record = await store.get(key, { type: "json", consistency: "strong" });
    if (!record || record.access_token_hash !== hash(accessToken)) return json({ error: "இந்த Order-ஐ அணுக முடியவில்லை." }, 404);

    const expected = createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest();
    const received = Buffer.from(signature, "hex");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return json({ error: "Payment கையொப்பம் சரிபார்க்கப்படவில்லை." }, 401);
    }

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const headers = { Authorization: `Basic ${auth}` };
    let paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, { headers });
    let payment = await paymentResponse.json();
    if (!paymentResponse.ok || payment.order_id !== orderId || payment.amount !== AMOUNT || payment.currency !== "INR") {
      return json({ error: "பணம் செலுத்திய விவரங்கள் பொருந்தவில்லை. உதவிக்கு தொடர்புகொள்ளவும்." }, 400);
    }

    if (payment.status === "authorized") {
      const captureResponse = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/capture`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ amount: AMOUNT, currency: "INR" })
      });
      payment = await captureResponse.json();
      if (!captureResponse.ok && payment.error?.code !== "BAD_REQUEST_ERROR") {
        console.error("Payment capture pending:", payment.error?.code || captureResponse.status);
      }
      if (payment.status !== "captured") {
        const retryResponse = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, { headers });
        payment = await retryResponse.json();
      }
    }
    if (payment.status !== "captured") return json({ success: false, status: "pending", message: "பணம் உறுதிப்படுத்தப்படுகிறது. சில விநாடிகளில் மீண்டும் முயற்சிக்கவும்." }, 202);

    await updateRecord(store, key, current => ({ ...current, status: "paid", payment_id: paymentId, paid_at: current.paid_at || new Date().toISOString() }));
    return json({ success: true, status: "paid", order_id: orderId });
  } catch (error) {
    console.error("Payment verification error:", error.message);
    return json({ error: "Payment சரிபார்ப்பில் தற்காலிக சிக்கல். உங்கள் Order பாதுகாப்பாக உள்ளது; மீண்டும் முயற்சிக்கவும்." }, 500);
  }
};
