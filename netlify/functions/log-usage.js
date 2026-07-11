/**
 * CV Pengo — usage logger
 *
 * Forwards anonymous usage stats to a Google Apps Script webhook that appends
 * a row to a Google Sheet. Keeps the webhook URL server-side.
 *
 * Set USAGE_WEBHOOK_URL in Netlify: Site settings -> Environment variables.
 * If it's not set, this function quietly no-ops — the app works fine without it.
 *
 * Privacy: only timestamps and scores are logged. No names, no filenames,
 * no CV content — consistent with the "we don't store your CV" promise.
 */

// Cross-origin: called from whatever host the frontend is served on, so the
// browser sends a CORS preflight OPTIONS request before the real POST.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS_HEADERS, body: "" };
  }

  const url = process.env.USAGE_WEBHOOK_URL;
  if (!url) {
    // Not configured — succeed silently so the frontend never sees an error.
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: true, logged: false }),
    };
  }

  let data = {};
  try {
    data = JSON.parse(event.body || "{}");
  } catch {
    /* ignore malformed body; log what we can */
  }

  const row = {
    overallScore: Number(data.overallScore) || "",
    atsScore: Number(data.atsScore) || "",
    jobMatchScore: Number(data.jobMatchScore) || "",
    hasJd: !!data.hasJd,
  };

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });
  } catch {
    /* Logging must never break the app — swallow errors. */
  }

  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true, logged: true }) };
};
