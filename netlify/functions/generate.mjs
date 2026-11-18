// Netlify Function  →  /.netlify/functions/generate
// Env vars (Netlify → Site settings → Environment variables):
//   GEMINI_API_KEY   (முதன்மை)   |   விரும்பினால்: GEMINI_MODEL (default: gemini-3.5-flash-lite)
//   மாற்று: ANTHROPIC_API_KEY அல்லது OPENAI_API_KEY

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const SYSTEM = "நீ தமிழ்க் கவிஞர். கேட்கப்பட்ட JSON வடிவில் மட்டும் பதிலளி; வேறு எதுவும் எழுதாதே.";

async function callGemini(prompt) {
  // முதலில் உங்கள் model; தோல்வியடைந்தால் மாற்று model
  const models = [process.env.GEMINI_MODEL || "gemini-3.5-flash-lite", "gemini-flash-lite-latest"];
  let last;
  for (const model of models) {
    try {
      const r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 1, maxOutputTokens: 2048 },
          }),
        }
      );
      const body = await r.text();
      if (!r.ok) throw new Error("gemini " + r.status + " [" + model + "] " + body.slice(0, 300));
      const d = JSON.parse(body);
      const t = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      if (!t) throw new Error("gemini empty [" + model + "] " + (d.candidates?.[0]?.finishReason || d.promptFeedback?.blockReason || ""));
      return t;
    } catch (e) {
      last = e;
      console.error(e.message);
    }
  }
  throw last;
}

async function callAnthropic(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error("anthropic " + r.status + " " + (await r.text()));
  const d = await r.json();
  return (d.content || []).map((c) => c.text || "").join("");
}

async function callOpenAI(prompt) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + process.env.OPENAI_API_KEY,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!r.ok) throw new Error("openai " + r.status + " " + (await r.text()));
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "";
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST மட்டும் அனுமதிக்கப்படும்." }, 405);

  let prompt;
  try {
    ({ prompt } = await req.json());
  } catch {
    return json({ error: "தவறான கோரிக்கை." }, 400);
  }
  // இந்த function-ஐ வேறு யாரும் இலவச AI-ஆகப் பயன்படுத்தாமல் இருக்க எளிய சரிபார்ப்பு
  if (typeof prompt !== "string" || prompt.length < 20 || prompt.length > 8000 || !prompt.includes("Unicode grapheme")) {
    return json({ error: "தவறான கோரிக்கை." }, 400);
  }

  try {
    let text;
    if (process.env.GEMINI_API_KEY) text = await callGemini(prompt);
    else if (process.env.ANTHROPIC_API_KEY) text = await callAnthropic(prompt);
    else if (process.env.OPENAI_API_KEY) text = await callOpenAI(prompt);
    else return json({ error: "சேவையகத்தில் API key அமைக்கப்படவில்லை." }, 500);

    const m = text.match(/\{[\s\S]*\}/);
    const data = JSON.parse(m ? m[0] : text);
    if (!Array.isArray(data.lines) || !data.lines.length) throw new Error("lines missing");
    return json({ lines: data.lines.map((l) => String(l).trim()) });
  } catch (e) {
    console.error(e);
    // சோதனை காலத்தில் காரணத்தைக் காட்டுகிறது; எல்லாம் சரியானதும் இந்த (why) பகுதியை நீக்கிவிடலாம்
    const why = String((e && e.message) || "").replace(/key=[^&\s"]+/gi, "").slice(0, 220);
    return json({ error: "கவிதை உருவாக்க முடியவில்லை. (" + why + ")" }, 502);
  }
};
