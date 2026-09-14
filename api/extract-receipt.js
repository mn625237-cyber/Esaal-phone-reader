// Vercel serverless function — Phase 4. Runs on Google's servers, never in the
// browser, so the Gemini API key stays hidden (same env var as extract-phone.js).
//
// This is a NEW, SEPARATE endpoint from api/extract-phone.js. It does not import,
// call, or modify that file in any way — api/extract-phone.js is untouched and
// keeps working exactly as before, independently of this endpoint.
//
// Scope: extracts everything that's actually readable on the receipt photo —
// phone, address fields, restaurant, area, and a free-text payment note/hint.
// Every field EXCEPT phone is a suggestion only: the frontend must treat it as
// pre-filled text the driver can review/edit/clear, never as confirmed data.
// This endpoint NEVER returns or infers a delivery fee, and paymentHint is never
// used to silently set the financial paymentType — that stays a manual driver
// action, same as Phase 3.

const PROMPT = `You are reading a photo of an Egyptian restaurant delivery receipt, written in Arabic and/or English. Extract ONLY what is clearly visible on the receipt itself — never guess, infer, or invent a plausible-looking value for anything that isn't actually printed or handwritten there. If a field is unclear, missing, or ambiguous, respond with null for that field.

Fields to extract:
- phone: the customer's mobile phone number. Egyptian mobile numbers start with 01 and have exactly 11 digits (e.g. 01012345678). They may appear with a +20 country code, spaces, or dashes, or be duplicated in different formats on the same receipt. If several phone-like numbers appear, prefer the one nearest "Customer Information" or the delivery address, not a restaurant hotline or order number.
- building: the building/villa number or name, if present.
- floor: the floor number, if present.
- apt: the apartment/unit number, if present.
- restaurant: the restaurant's own name, if printed on the receipt (e.g. as a letterhead or logo text) — not the customer's name.
- area: ONLY the neighborhood/district/area name (e.g. "المعادي", "مدينة نصر", "6 أكتوبر"). Never put a full street address here, and never combine it with building/floor/apartment text — those belong only in their own separate fields above. If you cannot clearly isolate a standalone area/neighborhood name from the rest of the address text, respond with null for area rather than guessing or merging fields.
- payment: any free-text payment note printed on the receipt (for example "فيزا", "كاش", or an amount with currency). Copy it close to as written; do not interpret or convert it.
- paymentHint: an object {type, amountText}. type is "cash" only if the receipt clearly and explicitly indicates cash payment, "visa" only if it clearly and explicitly indicates card/online payment, "unclear" if there is payment-related text but the method isn't clearly one of those two, or null if there is no payment information on the receipt at all. amountText is any order-total text exactly as printed (e.g. "275 ج"), or null if no total is visible.

Respond with ONLY raw JSON and nothing else — no markdown fences, no explanation, no extra keys. Use exactly this shape:
{"phone": "01XXXXXXXXX"|null, "building": string|null, "floor": string|null, "apt": string|null, "restaurant": string|null, "area": string|null, "payment": string|null, "paymentHint": {"type": "cash"|"visa"|"unclear"|null, "amountText": string|null}}`;

// Duplicated deliberately from api/extract-phone.js rather than imported/shared,
// so that file remains completely untouched (its own locked, verified behavior).
// Converts Arabic-Indic (٠-٩) and Extended Arabic-Indic/Persian (۰-۹) digits to
// Latin digits, strips separators, normalizes a +20/0020 prefix, then accepts
// the result ONLY if it's a genuine 11-digit Egyptian mobile number.
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;

  const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
  const persianIndic = '۰۱۲۳۴۵۶۷۸۹';
  let s = raw
    .replace(/[٠-٩]/g, (d) => String(arabicIndic.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(persianIndic.indexOf(d)));

  const hadPlus = s.trim().startsWith('+');
  s = s.replace(/[^\d]/g, '');

  if (hadPlus && s.startsWith('20')) {
    s = '0' + s.slice(2);
  } else if (s.startsWith('0020')) {
    s = '0' + s.slice(4);
  } else if (s.startsWith('20') && s.length === 12) {
    s = '0' + s.slice(2);
  }

  return /^01[0125]\d{8}$/.test(s) ? s : null;
}

// Sanitizes a suggested text field: must be a non-empty string after trimming,
// capped to a sane length (receipts don't have paragraph-length field values —
// this is just an abuse/garbage-output guard, not a business rule). Anything
// else (wrong type, empty, absurdly long) becomes null rather than being passed
// through as-is, since every one of these fields is a suggestion the UI will
// display directly.
function sanitizeSuggestedText(raw, maxLen = 120) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function sanitizePaymentHint(raw) {
  const fallback = { type: null, amountText: null };
  if (!raw || typeof raw !== 'object') return fallback;
  const type = ['cash', 'visa', 'unclear'].includes(raw.type) ? raw.type : null;
  const amountText = sanitizeSuggestedText(raw.amountText, 40);
  return { type, amountText };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'server not configured — missing GEMINI_API_KEY' });
    return;
  }

  const { image } = req.body || {};
  if (!image || typeof image !== 'string') {
    res.status(400).json({ error: 'missing image' });
    return;
  }

  // Phase 6 — payload-size guard, identical policy to api/extract-phone.js (see the
  // comment there for the full reasoning): public unauthenticated endpoint, bounding
  // cost/abuse exposure, not a business rule. Duplicated deliberately rather than
  // shared, same pattern as normalizePhone() above.
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
            // NOTE: this value is a reasoned estimate for an 8-field JSON response
            // (vs. extract-phone.js's single-field 64), not empirically load-tested
            // against the live Gemini API (no network access in the dev/test
            // environment this endpoint was built in). Watch for truncated/invalid
            // JSON in practice and raise this if that ever happens — do not lower
            // it without a concrete observed reason, per project rules.
            maxOutputTokens: 220,
            responseMimeType: 'application/json',
            // Same minimal-thinking setting as extract-phone.js, for the same
            // reason: this model family's floor is "low", and the task is a
            // similarly bounded extraction job (more fields, not more reasoning).
            thinkingConfig: { thinkingLevel: 'low' },
            responseSchema: {
              type: 'OBJECT',
              properties: {
                phone: { type: 'STRING', nullable: true },
                building: { type: 'STRING', nullable: true },
                floor: { type: 'STRING', nullable: true },
                apt: { type: 'STRING', nullable: true },
                restaurant: { type: 'STRING', nullable: true },
                area: { type: 'STRING', nullable: true },
                payment: { type: 'STRING', nullable: true },
                paymentHint: {
                  type: 'OBJECT',
                  properties: {
                    type: { type: 'STRING', nullable: true },
                    amountText: { type: 'STRING', nullable: true },
                  },
                  required: ['type', 'amountText'],
                },
              },
              required: ['phone', 'building', 'floor', 'apt', 'restaurant', 'area', 'payment', 'paymentHint'],
            },
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const detail = await geminiRes.text();
      res.status(502).json({ error: 'gemini-request-failed', detail });
      return;
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/```json|```/g, '').trim();

    let parsed = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Malformed/truncated JSON from the model — fail closed to an all-null
      // response rather than guessing at partial data. The frontend's manual
      // entry path is unaffected either way.
      parsed = {};
    }

    const result = {
      phone: normalizePhone(typeof parsed.phone === 'string' ? parsed.phone : null),
      building: sanitizeSuggestedText(parsed.building),
      floor: sanitizeSuggestedText(parsed.floor),
      apt: sanitizeSuggestedText(parsed.apt),
      restaurant: sanitizeSuggestedText(parsed.restaurant),
      area: sanitizeSuggestedText(parsed.area),
      payment: sanitizeSuggestedText(parsed.payment, 60),
      paymentHint: sanitizePaymentHint(parsed.paymentHint),
    };

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: 'server-error' });
  }
};
