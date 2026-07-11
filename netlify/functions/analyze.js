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
 *
 * ---- Shared rate limiter ----
 * Gemini's free tier caps requests per minute PER PROJECT, not per user —
 * every visitor's browser calls this same function, which shares one
 * project-wide quota. A queue that only lived in one person's browser tab
 * couldn't prevent two different visitors from colliding, since each tab
 * is an isolated copy of the page with no idea what anyone else is doing.
 * This function tracks recent call timestamps in Netlify Blobs (shared,
 * server-side storage, free on all Netlify plans) so it can see calls from
 * EVERY visitor and make new requests wait their turn instead of all
 * racing for the same slots.
 */

import { connectLambda, getStore } from "@netlify/blobs";

const MODEL = "gemini-2.5-flash";

// Stay safely under Gemini's free-tier ~10-15 RPM cap, shared across all
// visitors. Each CV analysis makes 3 calls, so 10/minute supports roughly
// 3 analyses starting in the same 60-second window before others queue.
const WINDOW_MS = 60_000;
const MAX_CALLS_PER_WINDOW = 10;
const RATE_LIMIT_KEY = "gemini-call-log";

/**
 * Checks the shared call log. If under the limit, records this call and
 * allows it through. If at the limit, returns how long (ms) until the
 * oldest call in the window ages out, so the caller can be told when to
 * retry rather than guessing.
 */
async function reserveSlot() {
  // The entire function is wrapped in try/catch: if Netlify Blobs has any
  // problem at all — misconfiguration, transient outage, whatever — the
  // rate limiter must fail OPEN (allow the request) rather than crash the
  // handler. A broken courtesy feature should never take down the actual
  // CV analysis.
  try {
    const store = getStore("rate-limiter");

    let timestamps = [];
    try {
      const raw = await store.get(RATE_LIMIT_KEY, { type: "json" });
      if (Array.isArray(raw)) timestamps = raw;
    } catch {
      // No prior log yet, or a transient read error — proceed as if empty.
    }

    const now = Date.now();
    timestamps = timestamps.filter((t) => now - t < WINDOW_MS);

    if (timestamps.length >= MAX_CALLS_PER_WINDOW) {
      const oldest = timestamps[0];
      const retryAfterMs = Math.max(500, WINDOW_MS - (now - oldest) + 250);
      return { allowed: false, retryAfterMs };
    }

    timestamps.push(now);
    try {
      await store.setJSON(RATE_LIMIT_KEY, timestamps);
    } catch {
      // Best-effort logging — never block the actual request over this.
    }
    return { allowed: true };
  } catch {
    // getStore() itself failed, or something else went wrong that wasn't
    // already caught above. Skip rate limiting entirely for this request
    // rather than blocking the user.
    return { allowed: true };
  }
}

// Cross-origin: the frontend (e.g. local dev on localhost:5173, or any
// other host) calls this function on the cv-pengo.netlify.app origin, so
// the browser sends a CORS preflight OPTIONS request first. Without these
// headers the preflight is rejected and the real POST never gets sent.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  // Legacy-format Netlify Functions don't get Blobs credentials injected
  // automatically — connectLambda() wires them up from the request context.
  // Wrapped so that if it ever fails, the rate limiter simply fails open
  // (see reserveSlot) and the analysis itself is unaffected.
  try {
    connectLambda(event);
  } catch {
    /* Blobs unavailable — limiter will no-op for this request */
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "GEMINI_API_KEY is not configured on the server." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  const { prompt, pdfBase64 } = payload;
  if (!prompt || typeof prompt !== "string") {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Missing prompt" }),
    };
  }

  // Shared queue: check BEFORE spending a Gemini call, so a burst of
  // visitors gets spaced out server-side instead of every request racing
  // Gemini directly and getting rejected (which wastes quota on failures).
  const slot = await reserveSlot();
  if (!slot.allowed) {
    return {
      statusCode: 429,
      headers: { ...CORS_HEADERS, "Retry-After": String(Math.ceil(slot.retryAfterMs / 1000)) },
      body: JSON.stringify({
        error: "High demand right now — you're in a short queue.",
        retryAfterMs: slot.retryAfterMs,
      }),
    };
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
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: `Gemini error (${r.status})` }),
      };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return {
        statusCode: 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Invalid response from Gemini" }),
      };
    }

    const text = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("\n")
      .trim();

    if (!text) {
      return {
        statusCode: 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Empty response from Gemini" }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: e.message || "Server error" }),
    };
  }
};
