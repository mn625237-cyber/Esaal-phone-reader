// api/process.js
// Vercel Serverless Function - تتواصل مع OpenAI بشكل آمن.
// المفتاح يُقرأ من process.env.OPENAI_API_KEY ولا يظهر أبدًا في الواجهة.

const AI_MODEL = 'gpt-4o-mini';

// ✏️ غيّر هذا البرومبت حسب مشروعك.
// المثال الحالي: ترجمة قوائم الطعام إلى JSON.
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

  if (!process.env.OPENAI_API_KEY) {
    res.status(500).json({ error: 'Server missing OPENAI_API_KEY environment variable.' });
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

  const userContent = [];

  if (text) {
    userContent.push({
      type: 'text',
      text: `Here is the provided text:\n\n${text}`,
    });
  }

  if (image) {
    userContent.push({
      type: 'image_url',
      image_url: { url: image },
    });
  }

  userContent.push({
    type: 'text',
    text: AI_PROMPT,
  });

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that returns structured JSON.',
          },
          {
            role: 'user',
            content: userContent,
          },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      res.status(response.status).json({
        error: errorData.error?.message || 'OpenAI API request failed.',
      });
      return;
    }

    const data = await response.json();
    const result = data.choices?.[0]?.message?.content || '';

    res.status(200).json({ result });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Internal server error.' });
  }
};