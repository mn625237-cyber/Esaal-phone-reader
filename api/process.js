// api/process.js
// Vercel Serverless Function - تتواصل مع Google Gemini بشكل آمن.
// مفتاح API يُقرأ من process.env.GEMINI_API_KEY ولا يظهر أبدًا في الواجهة.

const AI_MODEL = 'gemini-1.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent`;

// ✏️ نفس البرومبت السابق: ترجمة قوائم الطعام إلى JSON.
const AI_PROMPT = `You are a helpful menu translator.
Extract all menu items from the provided image or text.
Translate each item into English if it is in another language.
Return ONLY valid JSON in this exact format:
{
  "menu": [
    {
      "name": "Original Name",
      "translation": "English Translation",
      "price": "Price if visible"
    }
  ],
  "notes": "Any additional notes"
}`;

/**
 * استخراج نوع الصورة وبيانات Base64 من Data URL.
 * مثال: data:image/jpeg;base64,/9j/4AAQ...
 */
function parseImageDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1],
    base64Data: match[2],
  };
}

module.exports = async function handler(req, res) {
  // CORS headers (مفيدة للتطوير المحلي)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({ error: 'Server missing GEMINI_API_KEY environment variable.' });
    return;
  }

  let payload = req.body;

  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      res.status(400).json({ error: 'Invalid JSON body.' });
      return;
    }
  }

  const { image, text } = payload || {};

  if (!image && !text) {
    res.status(400).json({ error: 'Please provide an image or text.' });
    return;
  }

  // تجهيز أجزاء المحتوى المرسلة إلى Gemini
  const parts = [];

  if (text) {
    parts.push({
      text: `Here is the provided text:\n\n${text}`,
    });
  }

  if (image) {
    const parsedImage = parseImageDataUrl(image);

    if (!parsedImage) {
      res.status(400).json({ error: 'Invalid image Data URL.' });
      return;
    }

    parts.push({
      inline_data: {
        mime_type: parsedImage.mimeType,
        data: parsedImage.base64Data,
      },
    });
  }

  // إضافة البرومبت كنص
  parts.push({
    text: AI_PROMPT,
  });

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
    generationConfig: {
      response_mime_type: 'application/json', // فرض مخرجات JSON
      maxOutputTokens: 2048,
    },
  };

  try {
    const response = await fetch(`${GEMINI_ENDPOINT}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      res.status(response.status).json({
        error: errorData.error?.message || 'Gemini API request failed.',
      });
      return;
    }

    const data = await response.json();

    // استخراج النص من أول مرشح
    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    res.status(200).json({ result });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Internal server error.' });
  }
};