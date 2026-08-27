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
  if (!image) {
    res.status(400).json({ error: 'missing image' });
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
      const detail = await geminiRes.text();
      res.status(502).json({ error: 'gemini-request-failed', detail });
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
    res.status(500).json({ error: 'server-error' });
  }
};
