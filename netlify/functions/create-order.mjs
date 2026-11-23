import { randomBytes, createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

const AMOUNT = 1430;
const REGION = "ap-southeast-1";
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});
const hash = (value) => createHash("sha256").update(value).digest("hex");

export default async (request) => {
  if (request.method !== "POST") return json({ error: "POST மட்டும் அனுமதிக்கப்படும்." }, 405);
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return json({ error: "Payment சேவை இப்போது கிடைக்கவில்லை." }, 503);

  try {
    const body = await request.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const relationship = String(body.relationship || "");
    const language = String(body.language || "");
    const prompts = body.prompts;
    const allowed = ["friend", "lover", "mother", "father", "spouse", "sibling", "self"];
    if (!name || Array.from(name).length > 60 || !allowed.includes(relationship) || !["tamil", "tanglish"].includes(language) ||
        !Array.isArray(prompts) || prompts.length !== 3 || prompts.some(p => typeof p !== "string" || p.length < 100 || p.length > 8000 || !p.includes("Unicode grapheme"))) {
      return json({ error: "பெயர் அல்லது கவிதை விவரங்கள் சரியாக இல்லை. மீண்டும் முயற்சிக்கவும்." }, 400);
    }

    const receipt = "PK" + Date.now() + randomBytes(4).toString("hex");
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: AMOUNT, currency: "INR", receipt, partial_payment: false,
        notes: { product: "PeyarKavithai", purpose: "Tamil Name Poetry" } })
    });
    const result = await response.json();
    if (!response.ok || !result.id) {
      console.error("Razorpay order creation failed:", result.error?.code || response.status);
      return json({ error: "Payment தொடங்க முடியவில்லை. சிறிது நேரம் கழித்து முயற்சிக்கவும்." }, 502);
    }

    const accessToken = randomBytes(32).toString("hex");
    const record = {
      order_id: result.id, name, relationship, language, prompts,
      amount: AMOUNT, currency: "INR", status: "created",
      access_token_hash: hash(accessToken), created_at: new Date().toISOString(),
      poems: null, regen_used: false, generation_state: "idle"
    };
    const store = getStore({ name: "peyarkavithai-orders", region: REGION });
    const saved = await store.setJSON(`order-${result.id}`, record, { onlyIfNew: true });
    if (!saved.modified) return json({ error: "Order சேமிக்க முடியவில்லை. மீண்டும் முயற்சிக்கவும்." }, 500);

    return json({ success: true, key_id: keyId, order_id: result.id, amount: AMOUNT, currency: "INR", access_token: accessToken });
  } catch (error) {
    console.error("Create order error:", error.message);
    return json({ error: "Payment சேவை தற்காலிகமாகக் கிடைக்கவில்லை." }, 500);
  }
};
