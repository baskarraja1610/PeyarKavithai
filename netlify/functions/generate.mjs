
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
      JSON.stringify({ success: false, error: "Method not allowed" }),
      { status: 405, headers }
    );
  }

  try {
    const { prompt } = await request.json();

    if (!prompt || typeof prompt !== "string") {
      return new Response(
        JSON.stringify({ success: false, error: "Prompt missing" }),
        { status: 400, headers }
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error("Anthropic API key is not configured");
    }

    const model =
      process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

    const response = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          messages: [
            {
              role: "user",
              content: prompt
            }
          ]
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error?.message || "AI generation failed"
      );
    }

    const text = result.content
      ?.filter(item => item.type === "text")
      .map(item => item.text)
      .join("\n");

    if (!text) {
      throw new Error("Empty AI response");
    }

    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const parsed = JSON.parse(cleaned);

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
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || "Something went wrong"
      }),
      { status: 500, headers }
    );
  }
};
