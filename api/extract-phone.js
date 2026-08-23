// Vercel serverless function — runs on Google's servers, never in the browser,
// so the Gemini API key stays hidden (set as an environment variable, see README).

const PROMPT = `You are reading a photo of an Egyptian restaurant delivery receipt. Find the customer's mobile phone number. Egyptian mobile numbers start with 01 and have exactly 11 digits total (e.g. 01012345678). They may appear with a +20 country code, spaces, or dashes, or may be duplicated in different formats on the same receipt. If several phone-like numbers appear, prefer the one nearest "Customer Information" or the delivery address, not a restaurant hotline or order number. Respond with ONLY raw JSON and nothing else - no markdown fences, no explanation: {"phone": "01XXXXXXXXX"} using exactly 11 digits and no other characters, or {"phone": null} if you cannot find one.`;

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
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
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
              { inline_data: { mime_type: 'image/jpeg', data: image } },
            ],
          }],
          generationConfig: {
            maxOutputTokens: 2048,
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

    let phone = null;
    try {
      phone = JSON.parse(cleaned).phone || null;
    } catch (e) {
      const match = cleaned.match(/01[0125]\d{8}/);
      phone = match ? match[0] : null;
    }

    res.status(200).json({ phone });
  } catch (err) {
    res.status(500).json({ error: 'server-error' });
  }
};
