/**
 * CV Pengo — analysis proxy
 *
 * Keeps the Gemini API key on the server. The frontend sends:
 *   { prompt: string, pdfBase64?: string }
 * and receives:
 *   { text: string }   — the model's raw text (JSON produced by the prompt)
 *
 * Set GEMINI_API_KEY in Netlify: Site settings -> Environment variables.
 * NEVER commit the key to this repo.
 */

const MODEL = "gemini-2.5-flash";

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "GEMINI_API_KEY is not configured on the server." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { prompt, pdfBase64 } = payload;
  if (!prompt || typeof prompt !== "string") {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing prompt" }) };
  }

  // Build Gemini "parts": text prompt, plus the PDF itself if the frontend
  // couldn't extract text (e.g. scanned resumes). Gemini reads PDFs natively.
  const parts = [];
  if (pdfBase64) {
    parts.push({ inline_data: { mime_type: "application/pdf", data: pdfBase64 } });
  }
  parts.push({ text: prompt });

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            // Forces valid JSON output — pairs with the JSON-only prompts.
            responseMimeType: "application/json",
            temperature: 0.4,
            maxOutputTokens: 2048,
          },
        }),
      }
    );

    const raw = await r.text();

    if (!r.ok) {
      // Pass the status through so the frontend's retry/backoff logic works
      // (429 = rate limited, 5xx = transient).
      return {
        statusCode: r.status,
        body: JSON.stringify({ error: `Gemini error (${r.status})` }),
      };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { statusCode: 502, body: JSON.stringify({ error: "Invalid response from Gemini" }) };
    }

    const text = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("\n")
      .trim();

    if (!text) {
      return { statusCode: 502, body: JSON.stringify({ error: "Empty response from Gemini" }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || "Server error" }) };
  }
};
