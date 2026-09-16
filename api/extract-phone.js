// Vercel serverless function — runs on Google's servers, never in the browser,
// so the Gemini API key stays hidden (set as an environment variable, see README).
//
// MVP scope: this endpoint only extracts the phone number. Address, restaurant,
// area, and payment method are entered manually in the UI. Gemini's own output
// is never trusted blindly — normalizePhone() re-validates it independently.

const PROMPT = `You are reading a photo of an Egyptian restaurant delivery receipt. Find the customer's mobile phone number. Egyptian mobile numbers start with 01 and have exactly 11 digits total (e.g. 01012345678). They may appear with a +20 country code, spaces, or dashes, or may be duplicated in different formats on the same receipt. If several phone-like numbers appear, prefer the one nearest "Customer Information" or the delivery address, not a restaurant hotline or order number. Respond with ONLY raw JSON and nothing else - no markdown fences, no explanation: {"phone": "01XXXXXXXXX"} using exactly 11 digits and no other characters, or {"phone": null} if you cannot find one.`;

// Converts Arabic-Indic (٠-٩) and Extended Arabic-Indic/Persian (۰-۹) digits to
// Latin digits, strips separators, normalizes a +20/0020 prefix, then accepts
// the result ONLY if it's a genuine 11-digit Egyptian mobile number (01[0125]xxxxxxxx).
// Returns null for anything that doesn't pass — Gemini's formatting is never trusted alone.
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;

  const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
  const persianIndic = '۰۱۲۳۴۵۶۷۸۹';
  let s = raw
    .replace(/[٠-٩]/g, (d) => String(arabicIndic.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(persianIndic.indexOf(d)));

  const hadPlus = s.trim().startsWith('+');
  s = s.replace(/[^\d]/g, ''); // strip spaces, dashes, parentheses, the '+' itself, etc.

  if (hadPlus && s.startsWith('20')) {
    s = '0' + s.slice(2);
  } else if (s.startsWith('0020')) {
    s = '0' + s.slice(4);
  } else if (s.startsWith('20') && s.length === 12) {
    // no + or 00 captured, but a 12-digit string starting with 20 is almost
    // certainly a +20 Egyptian number with the prefix symbol stripped upstream
    s = '0' + s.slice(2);
  }

  return /^01[0125]\d{8}$/.test(s) ? s : null;
}

// ============================================================
// Phase 10 — A: Gemini API Protection (rate limiting).
//
// Both extraction endpoints are public and unauthenticated, so the payload-size guard
// (Phase 6) alone doesn't stop repeated SMALL requests from draining the Gemini quota.
// This adds a per-IP request-frequency limit using Upstash Redis's REST API, called
// directly via fetch — deliberately NOT the @upstash/redis npm SDK, because this project
// has zero npm dependencies today (no package.json) and adding one would turn every
// future deploy into an `npm install` step this mobile-only, no-CLI workflow can't easily
// debug if it ever breaks. The REST API needs nothing but fetch, which this file already
// uses for Gemini itself.
//
// Configuration: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN as Vercel
// environment variables (see deployment notes). These are the exact names Vercel's own
// "Upstash for Redis" Marketplace storage integration injects automatically when you
// connect a database to this project — no manual credential copying needed.
//
// FAIL-OPEN BY DESIGN: if the env vars are missing, or the Upstash call fails/errors for
// any reason (outage, network hiccup, wrong credentials), the request is ALLOWED through
// exactly as it behaved before Phase 10. A broken or not-yet-configured rate limiter must
// never take down real courier usage — it only means this one abuse guard is temporarily
// inactive, same "safety net, not a gate" spirit as sw.js's Share Target fallback redirect.
//
// Data minimalism: the only thing stored is a per-IP integer counter under a key that
// self-expires every window — no image, no personal data, no request content is ever
// sent to or kept in the rate-limit store.
const RATE_LIMIT_MAX = 30;         // max requests per IP per window — generous enough for
                                    // a full batch upload (extractPhone() is also called
                                    // once per photo, sequentially, by handleBatch() in
                                    // index.html)
const RATE_LIMIT_WINDOW_SECONDS = 60;

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  if (typeof req.headers['x-real-ip'] === 'string') return req.headers['x-real-ip'];
  return 'unknown'; // never block on a missing/unparseable IP — see fail-open note above
}

async function checkRateLimit(ip) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { allowed: true, configured: false };

  try {
    const key = `ratelimit:extract-phone:${ip}`;
    const pipelineRes = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, RATE_LIMIT_WINDOW_SECONDS],
      ]),
    });
    if (!pipelineRes.ok) return { allowed: true, configured: true }; // fail open
    const results = await pipelineRes.json();
    const count = results?.[0]?.result;
    if (typeof count !== 'number') return { allowed: true, configured: true }; // fail open
    return { allowed: count <= RATE_LIMIT_MAX, configured: true, count };
  } catch (e) {
    console.error('[extract-phone] rate-limit check failed — failing open', e);
    return { allowed: true, configured: true };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  // Phase 10 — A: Gemini API Protection. Checked before the API key / image validation
  // so a rate-limited caller never even reaches the point of touching Gemini quota.
  const clientIp = getClientIp(req);
  const rateLimit = await checkRateLimit(clientIp);
  if (!rateLimit.allowed) {
    res.status(429).json({ error: 'rate-limited' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Phase 10 — API Error Privacy: the specific missing env var name is an internal
    // implementation detail; log it server-side only (Vercel function logs), never in
    // the response body. The client only needs to know the server isn't usable right now.
    console.error('[extract-phone] server not configured — missing GEMINI_API_KEY');
    res.status(500).json({ error: 'server-not-configured' });
    return;
  }

  const { image } = req.body || {};
  if (!image || typeof image !== 'string') {
    res.status(400).json({ error: 'missing image' });
    return;
  }

  // Phase 6 — payload-size guard. This is a public, unauthenticated endpoint, so it
  // needs a bound on request cost/abuse exposure, not a business rule: the app's own
  // resize pipeline (maxDim 1100px, JPEG quality 0.75) produces base64 payloads far
  // smaller than this ceiling for every real receipt photo. 8M base64 chars ≈ 6MB raw
  // image — generous headroom over any legitimate use, same "abuse guard, not business
  // rule" spirit as sw.js's MAX_IMAGE_BYTES ceiling for the Share Target flow.
  const MAX_BASE64_CHARS = 8 * 1024 * 1024;
  if (image.length > MAX_BASE64_CHARS) {
    res.status(413).json({ error: 'image too large' });
    return;
  }

  try {
    const geminiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: PROMPT },
              { inlineData: { mimeType: 'image/jpeg', data: image } },
            ],
          }],
          generationConfig: {
            maxOutputTokens: 64,
            responseMimeType: 'application/json',
            // Gemini 3.5 Flash-Lite doesn't support fully disabling thinking —
            // "low" is the minimum available level for this model family.
            thinkingConfig: { thinkingLevel: 'low' },
            responseSchema: {
              type: 'OBJECT',
              properties: {
                phone: { type: 'STRING', nullable: true },
              },
              required: ['phone'],
            },
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      // Phase 10 — API Error Privacy: geminiRes body can contain upstream diagnostic
      // text (and even reveals which AI provider is used) — log it server-side only,
      // never forward it to the client. Status code (502 = bad upstream) is preserved
      // so this stays a real, correctly-categorized failure, not a hidden one.
      const detail = await geminiRes.text();
      console.error('[extract-phone] upstream request failed', geminiRes.status, detail);
      res.status(502).json({ error: 'upstream-unavailable' });
      return;
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/```json|```/g, '').trim();

    let rawPhone = null;
    try {
      const parsed = JSON.parse(cleaned);
      rawPhone = typeof parsed.phone === 'string' ? parsed.phone : null;
    } catch (e) {
      const match = cleaned.match(/[\d٠-٩۰-۹]{9,15}/);
      rawPhone = match ? match[0] : null;
    }

    const phone = normalizePhone(rawPhone);
    res.status(200).json({ phone });
  } catch (err) {
    // Phase 10 — API Error Privacy: response body was already generic (no leak) —
    // the only addition here is internal visibility for debugging real failures.
    console.error('[extract-phone] unexpected server error', err);
    res.status(500).json({ error: 'server-error' });
  }
};
