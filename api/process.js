export default async function handler(req, res) {
  // السماح بطلبات POST فقط
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "Gemini API key is missing"
      });
    }

    const {
      imageBase64,
      mimeType
    } = req.body;


    if (!imageBase64) {
      return res.status(400).json({
        error: "No image received"
      });
    }


    const prompt = `
أنت نظام متخصص في قراءة إيصالات توصيل المطاعم المصرية.

مهمتك:
اقرأ صورة إيصال الطلب وابحث عن رقم هاتف العميل.

القواعد:
- الرقم المطلوب هو رقم موبايل مصري.
- يجب أن يبدأ بـ 01.
- يجب أن يكون بالضبط 11 رقم.
- ابحث بالقرب من:
  Customer Information
  Customer Info
  Delivery Address
  Phone
  Mobile
  Tel

إذا وجدت أكثر من رقم:
اختر رقم العميل وليس رقم المطعم أو السائق.

أعد النتيجة فقط بصيغة JSON بدون أي شرح:

إذا وجدت الرقم:
{
 "phone":"01XXXXXXXXX"
}

إذا لم تجد:
{
 "phone":null
}

لا تضف أي نص خارج JSON.
`;


    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },

        body: JSON.stringify({

          contents: [
            {
              parts: [

                {
                  text: prompt
                },

                {
                  inlineData: {
                    mimeType: mimeType || "image/jpeg",
                    data: imageBase64
                  }
                }

              ]
            }
          ],


          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0
          }

        })
      }
    );


    if (!response.ok) {

      const errorText = await response.text();

      console.error(errorText);

      return res.status(500).json({
        error: "Gemini API failed"
      });
    }


    const result = await response.json();


    let text =
      result?.candidates?.[0]
      ?.content
      ?.parts?.[0]
      ?.text;


    if (!text) {

      return res.json({
        phone: null
      });

    }


    let parsed;


    try {

      parsed = JSON.parse(text);

    } catch {

      parsed = {
        phone: null
      };

    }



    let phone = parsed.phone;


    // تحقق إضافي من الرقم
    if (
      typeof phone !== "string" ||
      !/^01\d{9}$/.test(phone)
    ) {

      phone = null;

    }


    return res.status(200).json({
      phone
    });



  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: "Server error"
    });

  }
}