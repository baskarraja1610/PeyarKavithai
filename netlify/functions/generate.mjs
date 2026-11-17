
export default async (request) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Method not allowed"
      }),
      { status: 405, headers }
    );
  }

  try {
    const { prompt } = await request.json();

    if (!prompt || typeof prompt !== "string") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Prompt missing"
        }),
        { status: 400, headers }
      );
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error("Gemini API key is not configured");
    }

    const model = "gemini-3.5-flash";

    console.log("Gemini request started");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: 2000
          }
        })
      }
    );

    console.log("Gemini HTTP status:", response.status);

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error?.message || "Gemini generation failed"
      );
    }

    const text = result.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!text) {
      throw new Error("Empty Gemini response");
    }

    const parsed = JSON.parse(text);

    if (
      !Array.isArray(parsed.lines) ||
      parsed.lines.length === 0 ||
      parsed.lines.length > 20
    ) {
      throw new Error("Invalid poem format");
    }

    return new Response(
      JSON.stringify({
        success: true,
        mode: "embedded",
        lines: parsed.lines
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error("Gemini Error:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error.name === "TimeoutError"
          ? "Gemini request timed out. Please try again."
          : error.message || "Something went wrong"
      }),
      { status: 500, headers }
    );
  }
};
