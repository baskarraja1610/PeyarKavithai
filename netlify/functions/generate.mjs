import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

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

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("கவிதைச் சேவை அமைக்கப்படவில்லை.");
  const models = [...new Set([process.env.GEMINI_MODEL || "gemini-3.5-flash-lite", "gemini-flash-lite-latest"])];
  let lastError;
  for (const model of models) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.85, maxOutputTokens: 4096 }
        })
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`gemini_${response.status}_${model}_${raw.slice(0, 180)}`);
      const payload = JSON.parse(raw);
      const text = (payload.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
      if (!text) throw new Error("gemini_empty_response");
      return text;
    } catch (error) {
      lastError = error;
      console.error("Gemini attempt failed:", error.message);
    }
  }
  throw lastError || new Error("AI service unavailable");
}

function parsePoems(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  const data = JSON.parse(match ? match[0] : raw);
  if (!Array.isArray(data.poems) || data.poems.length !== 3) throw new Error("three_poems_missing");
  return data.poems.map(p => {
    if (!p || !Array.isArray(p.lines) || !p.lines.length || p.lines.some(line => typeof line !== "string" || !line.trim())) throw new Error("poem_lines_invalid");
    return { mode: "embedded", lines: p.lines.map(line => line.trim()) };
  });
}
function graphemes(value) {
  const clean = String(value || "").replace(/\s+/g, "");
  try { return Array.from(new Intl.Segmenter("ta", { granularity: "grapheme" }).segment(clean), x => x.segment); }
  catch { return Array.from(clean); }
}
function romanInitial(g) {
  const map = {"அ":"a","ஆ":"a","இ":"i","ஈ":"i","உ":"u","ஊ":"u","எ":"e","ஏ":"e","ஐ":"i","ஒ":"o","ஓ":"o","ஔ":"au","க":"k","ங":"ng","ச":"s","ஞ":"ny","ட":"t","ண":"n","த":"th","ந":"n","ப":"p","ம":"m","ய":"y","ர":"r","ல":"l","வ":"v","ழ":"zh","ள":"l","ற":"r","ன":"n"};
  return map[String(g || "").charAt(0)] || String(g || "").charAt(0).toLowerCase();
}
function validatePoems(poems, record) {
  const letters = graphemes(record.name);
  if (!letters.length) return false;
  return poems.every(poem => poem.lines.length === letters.length && poem.lines.every((line, i) => {
    const target = record.language === "tanglish" ? (/^[A-Za-z]/.test(letters[i]) ? letters[i].toLowerCase() : romanInitial(letters[i])) : letters[i];
    if (record.language === "tanglish") return line.toLowerCase().startsWith(String(target).toLowerCase());
    const lineParts = graphemes(line).map(x => x.toLowerCase());
    const wanted = String(target).toLowerCase();
    return /[\u0B80-\u0BFF]/.test(wanted) && /[்]$/.test(wanted) ? lineParts.includes(wanted) : lineParts[0] === wanted;
  }));
}

export default async (request) => {
  if (request.method !== "POST") return json({ error: "POST மட்டும் அனுமதிக்கப்படும்." }, 405);
  try {
    const body = await request.json();
    const orderId = String(body.order_id || "");
    const accessToken = String(body.access_token || "");
    const action = String(body.action || "generate");
    if (!/^order_[A-Za-z0-9]+$/.test(orderId) || accessToken.length !== 64 || !["status", "generate", "regenerate"].includes(action)) {
      return json({ error: "தவறான Order விவரங்கள்." }, 400);
    }

    const store = getStore({ name: "peyarkavithai-orders", region: REGION });
    const key = `order-${orderId}`;
    let record = await store.get(key, { type: "json", consistency: "strong" });
    if (!record || record.access_token_hash !== hash(accessToken)) return json({ error: "இந்த Order-ஐ அணுக முடியவில்லை." }, 404);
    if (action === "status") {
      if (record.status === "created") {
        const keyId = process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;
        if (keyId && keySecret) {
          const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
          const check = await fetch(`https://api.razorpay.com/v1/orders/${orderId}`, { headers: { Authorization: `Basic ${auth}` } });
          const orderState = check.ok ? await check.json() : null;
          if (orderState?.status === "paid" && orderState.amount === 1430 && orderState.currency === "INR") {
            record = await updateRecord(store, key, current => ({ ...current, status: "paid", paid_at: current.paid_at || new Date().toISOString() }));
          }
        }
      }
      return json({ success: true, status: record.status, poems: record.poems || null, regen_used: !!record.regen_used, name: record.name, language: record.language, relationship: record.relationship });
    }
    if (record.status !== "paid" && record.status !== "delivered") return json({ error: "முதலில் Payment உறுதிப்படுத்தப்பட வேண்டும்." }, 402);

    if (action === "generate" && record.poems) return json({ success: true, poems: record.poems, regen_used: !!record.regen_used });
    if (action === "regenerate" && (!record.poems || record.regen_used)) return json({ error: "மீண்டும் கவிதை உருவாக்கும் வாய்ப்பு பயன்படுத்தப்பட்டுள்ளது." }, 409);

    const now = Date.now();
    if (record.generation_state === "working" && record.generation_lock_until && record.generation_lock_until > now) {
      return json({ error: "கவிதை ஏற்கனவே உருவாகிக்கொண்டிருக்கிறது. சில விநாடிகள் கழித்து முயற்சிக்கவும்." }, 409);
    }
    const originalStatus = record.status;
    const locked = await updateRecord(store, key, current => ({
      ...current, generation_state: "working", generation_action: action,
      generation_lock_until: now + 5 * 60 * 1000
    }));
    if (!locked) return json({ error: "Order கிடைக்கவில்லை." }, 404);

    try {
      const previous = action === "regenerate" ? JSON.stringify(record.poems) : "";
      const combinedPrompt = "நீ செம்மையான தமிழ் கவிஞர். கீழே உள்ள மூன்று தனித்தனி கவிதை வழிமுறைகளையும் பின்பற்றி, ஒவ்வொன்றுக்கும் தனித்தனி கவிதை உருவாக்கு. ஒவ்வொரு வழிமுறையிலும் குறிப்பிடப்பட்ட வரிகளின் எண்ணிக்கையும் பெயர் எழுத்து வரிசையும் கட்டாயம். இலக்கணம், எழுத்துப்பிழை, பொருள், இயல்பான சொல் தேர்வு ஆகியவற்றை கவனமாகச் சரிபார். கட்டாயமாக மூன்று கவிதைகள் மட்டும். ஒவ்வொரு கவிதையும் {\"lines\":[\"வரி 1\",\"வரி 2\"]} வடிவில் இருக்க வேண்டும். வெளியீடு JSON மட்டும்: {\"poems\":[{\"lines\":[]},{\"lines\":[]},{\"lines\":[]}]}.\n\n" +
        locked.prompts.map((p, i) => `கவிதை ${i + 1}:\n${p.replace(/JSON மட்டும் திருப்பு:[\s\S]*$/u, "")}`).join("\n\n") +
        (previous ? `\n\nமுந்தைய கவிதைகள்; இவற்றின் வரிகளையோ படிமங்களையோ மீண்டும் பயன்படுத்தாதே: ${previous}` : "");
      const raw = await callGemini(combinedPrompt);
      const poems = parsePoems(raw);
      if (!validatePoems(poems, locked)) throw new Error("name_acrostic_validation_failed");
      const finalRecord = await updateRecord(store, key, current => ({
        ...current, status: "delivered", poems, generation_state: "idle",
        generation_lock_until: null,
        regen_used: action === "regenerate" ? true : !!current.regen_used,
        delivered_at: new Date().toISOString()
      }));
      return json({ success: true, poems: finalRecord.poems, regen_used: !!finalRecord.regen_used });
    } catch (error) {
      console.error("Poem generation failed:", error.message);
      await updateRecord(store, key, current => ({
        ...current, status: originalStatus, generation_state: "idle", generation_lock_until: null,
        last_generation_error: String(error.message || "generation_failed").slice(0, 160)
      })).catch(e => console.error("Could not release generation lock:", e.message));
      return json({ error: "கவிதை உருவாக்கத்தில் தற்காலிக சிக்கல். உங்கள் Payment பாதுகாப்பாக உள்ளது; மீண்டும் முயற்சிக்கலாம்." }, 502);
    }
  } catch (error) {
    console.error("Generate function error:", error.message);
    return json({ error: "சேவை தற்காலிகமாகக் கிடைக்கவில்லை. மீண்டும் முயற்சிக்கவும்." }, 500);
  }
};
