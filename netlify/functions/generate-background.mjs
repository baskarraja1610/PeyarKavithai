import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

const REGION = "ap-southeast-1";
const AMOUNT = 1430;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});
const hash = value => createHash("sha256").update(value).digest("hex");

async function updateRecord(store, key, updater) {
  for (let i = 0; i < 6; i++) {
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
  if (!apiKey) throw new Error("GEMINI_API_KEY_missing");

  const models = [...new Set([
    process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite"
  ])];
  let lastError;

  for (const model of models) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.75,
              maxOutputTokens: 4096
            }
          }),
          signal: AbortSignal.timeout(120000)
        }
      );

      const raw = await response.text();
      if (!response.ok) {
        let detail = raw.slice(0, 500);
        try {
          const parsed = JSON.parse(raw);
          detail = parsed.error?.message || parsed.error?.status || detail;
        } catch {}
        throw new Error(`Gemini ${model} HTTP ${response.status}: ${detail}`);
      }

      const payload = JSON.parse(raw);
      const candidate = payload.candidates?.[0];
      const text = (candidate?.content?.parts || []).map(part => part.text || "").join("");
      if (!text) {
        const reason = candidate?.finishReason || payload.promptFeedback?.blockReason || "empty_response";
        throw new Error(`Gemini ${model}: ${reason}`);
      }
      return text;
    } catch (error) {
      lastError = error;
      console.error("Gemini model attempt failed:", model, error?.message || error);
    }
  }
  throw lastError || new Error("Gemini unavailable");
}

function parsePoems(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  const data = JSON.parse(match ? match[0] : raw);
  if (!Array.isArray(data.poems) || data.poems.length !== 3) throw new Error("three_poems_missing");
  return data.poems.map(poem => {
    if (!poem || !Array.isArray(poem.lines) || !poem.lines.length ||
        poem.lines.some(line => typeof line !== "string" || !line.trim())) {
      throw new Error("poem_lines_invalid");
    }
    return { mode: "embedded", lines: poem.lines.map(line => line.trim()) };
  });
}

function graphemes(value) {
  const clean = String(value || "").replace(/\s+/g, "");
  try {
    return Array.from(new Intl.Segmenter("ta", { granularity: "grapheme" }).segment(clean), item => item.segment);
  } catch {
    return Array.from(clean);
  }
}

function romanInitial(grapheme) {
  const map = {
    "அ":"a","ஆ":"a","இ":"i","ஈ":"i","உ":"u","ஊ":"u","எ":"e","ஏ":"e","ஐ":"i","ஒ":"o","ஓ":"o","ஔ":"au",
    "க":"k","ங":"ng","ச":"s","ஞ":"ny","ட":"t","ண":"n","த":"th","ந":"n","ப":"p","ம":"m","ய":"y","ர":"r",
    "ல":"l","வ":"v","ழ":"zh","ள":"l","ற":"r","ன":"n"
  };
  return map[String(grapheme || "").charAt(0)] || String(grapheme || "").charAt(0).toLowerCase();
}

function validatePoems(poems, record) {
  const letters = graphemes(record.name);
  if (!letters.length) return false;
  return poems.every(poem =>
    poem.lines.length === letters.length &&
    poem.lines.every((line, index) => {
      const target = record.language === "tanglish"
        ? (/^[A-Za-z]/.test(letters[index]) ? letters[index].toLowerCase() : romanInitial(letters[index]))
        : letters[index];

      if (record.language === "tanglish") {
        return line.toLowerCase().startsWith(String(target).toLowerCase());
      }

      const lineParts = graphemes(line).map(part => part.toLowerCase());
      const wanted = String(target).toLowerCase();
      return /[\u0B80-\u0BFF]/.test(wanted) && /[்]$/.test(wanted)
        ? lineParts.includes(wanted)
        : lineParts[0] === wanted;
    })
  );
}

export default async request => {
  if (request.method !== "POST") return json({ error: "POST மட்டும் அனுமதிக்கப்படும்." }, 405);

  let orderId = "";
  let action = "generate";
  let store;
  let key;

  try {
    const body = await request.json();
    orderId = String(body.order_id || "");
    const accessToken = String(body.access_token || "");
    action = String(body.action || "generate");

    if (!/^order_[A-Za-z0-9]+$/.test(orderId) ||
        accessToken.length !== 64 ||
        !["generate", "regenerate"].includes(action)) {
      return json({ error: "தவறான Order விவரங்கள்." }, 400);
    }

    store = getStore({ name: "peyarkavithai-orders", region: REGION });
    key = `order-${orderId}`;

    const record = await store.get(key, { type: "json", consistency: "strong" });
    if (!record || record.access_token_hash !== hash(accessToken)) {
      return json({ error: "இந்த Order-ஐ அணுக முடியவில்லை." }, 404);
    }
    if (record.status !== "paid" && record.status !== "delivered") {
      return json({ error: "முதலில் Payment உறுதிப்படுத்தப்பட வேண்டும்." }, 402);
    }
    if (action === "generate" && record.poems) return json({ accepted: true, already_delivered: true });
    if (action === "regenerate" && (!record.poems || record.regen_used)) {
      return json({ error: "மீண்டும் கவிதை உருவாக்கும் வாய்ப்பு பயன்படுத்தப்பட்டுள்ளது." }, 409);
    }

    const now = Date.now();
    if (record.generation_state === "working" &&
        record.generation_lock_until && record.generation_lock_until > now) {
      return json({ accepted: true, already_working: true });
    }

    const locked = await updateRecord(store, key, current => ({
      ...current,
      generation_state: "working",
      generation_action: action,
      generation_lock_until: now + 14 * 60 * 1000,
      last_generation_error: null
    }));
    if (!locked) throw new Error("order_record_missing");

    try {
      const previous = action === "regenerate" ? JSON.stringify(record.poems) : "";
      const combinedPrompt =
        "நீ செம்மையான தமிழ் கவிஞர். கீழே உள்ள மூன்று தனித்தனி கவிதை வழிமுறைகளையும் பின்பற்றி, ஒவ்வொன்றுக்கும் தனித்தனி கவிதை உருவாக்கு. ஒவ்வொரு வழிமுறையிலும் குறிப்பிடப்பட்ட வரிகளின் எண்ணிக்கையும் பெயர் எழுத்து வரிசையும் கட்டாயம். இலக்கணம், எழுத்துப்பிழை, பொருள், இயல்பான சொல் தேர்வு ஆகியவற்றை கவனமாகச் சரிபார். கட்டாயமாக மூன்று கவிதைகள் மட்டும். ஒவ்வொரு கவிதையும் {\"lines\":[\"வரி 1\",\"வரி 2\"]} வடிவில் இருக்க வேண்டும். வெளியீடு JSON மட்டும்: {\"poems\":[{\"lines\":[]},{\"lines\":[]},{\"lines\":[]}]}.\n\n" +
        locked.prompts.map((prompt, index) =>
          `கவிதை ${index + 1}:\n${String(prompt).replace(/JSON மட்டும் திருப்பு:[\s\S]*$/u, "")}`
        ).join("\n\n") +
        (previous
          ? `\n\nமுந்தைய கவிதைகள்; இவற்றின் வரிகளையோ படிமங்களையோ மீண்டும் பயன்படுத்தாதே: ${previous}`
          : "");

      const raw = await callGemini(combinedPrompt);
      const poems = parsePoems(raw);
      if (!validatePoems(poems, locked)) throw new Error("name_acrostic_validation_failed");

      const finalRecord = await updateRecord(store, key, current => ({
        ...current,
        status: "delivered",
        poems,
        generation_state: "idle",
        generation_lock_until: null,
        regen_used: action === "regenerate" ? true : !!current.regen_used,
        delivered_at: new Date().toISOString(),
        last_generation_error: null
      }));

      console.log("Poems delivered:", orderId, action);
      return json({ success: true, delivered: !!finalRecord?.poems });
    } catch (error) {
      console.error("Poem background generation failed:", orderId, error?.message || error);
      await updateRecord(store, key, current => ({
        ...current,
        generation_state: "failed",
        generation_lock_until: null,
        last_generation_error: String(error?.message || "generation_failed").slice(0, 300)
      })).catch(updateError => console.error("Could not save generation failure:", updateError?.message || updateError));
      return json({ accepted: true, generation_failed: true });
    }
  } catch (error) {
    console.error("Generate background handler error:", orderId, error?.message || error);
    if (store && key) {
      await updateRecord(store, key, current => ({
        ...current,
        generation_state: "failed",
        generation_lock_until: null,
        last_generation_error: String(error?.message || "background_handler_failed").slice(0, 300)
      })).catch(() => {});
    }
    return json({ error: "கவிதைச் சேவையில் தற்காலிக சிக்கல். மீண்டும் முயற்சிக்கலாம்." }, 500);
  }
};

export const config = { background: true };
