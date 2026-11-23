பெயர்கவிதை – Razorpay Payment + கவிதை பாதுகாப்பு மாற்றங்கள்

இந்தத் தொகுப்பில் உள்ள கோப்புகள்:
1. index.html
2. netlify/functions/create-order.mjs
3. netlify/functions/verify-payment.mjs  (புதிய கோப்பு)
4. netlify/functions/generate.mjs
5. netlify/functions/razorpay-webhook.mjs
6. package.json

GitHub-ல் செய்ய வேண்டியது:
- பழைய index.html-ஐ இந்த index.html-ஆல் முழுமையாக மாற்றவும்.
- netlify/functions/create-order.mjs-ஐ மாற்றவும்.
- netlify/functions/generate.mjs-ஐ மாற்றவும்.
- netlify/functions/razorpay-webhook.mjs-ஐ மாற்றவும்.
- netlify/functions/verify-payment.mjs என்ற புதிய கோப்பை உருவாக்கி அதன் உள்ளடக்கத்தைச் சேர்க்கவும்.
- package.json-ஐ இதில் உள்ளபடி மாற்றவும்.
- எல்லா மாற்றங்களையும் ஒரே commit-ஆகச் செய்து, அதன் பிறகே ஒரே முறை deploy செய்யவும்.

Netlify Production Environment Variables (மதிப்புகளை யாரிடமும் பகிர வேண்டாம்):
- RAZORPAY_KEY_ID
- RAZORPAY_KEY_SECRET
- RAZORPAY_WEBHOOK_SECRET
- GEMINI_API_KEY
- GEMINI_MODEL (விருப்பம்; தற்போது இயங்கும் model ID இருந்தால் மட்டும்)

Razorpay Webhook URL:
https://peyarkavithai.netlify.app/.netlify/functions/razorpay-webhook

Webhook events:
- payment.captured
- payment.failed
- order.paid

கவனம்:
- Razorpay Dashboard-ல் webhook secret மற்றும் Netlify RAZORPAY_WEBHOOK_SECRET இரண்டும் ஒன்றாக இருக்க வேண்டும். Secret-ஐ chat-ல் அனுப்ப வேண்டாம்.
- இந்த code-ல் Order/Poem பதிவுகள் Netlify Blobs-இல் peyarkavithai-orders என்ற store-ல் ap-southeast-1 region-ல் சேமிக்கப்படும்.
- Webhook event பதிவுகள் razorpay-webhook-inbox store-ல் அதே region-ல் சேமிக்கப்படும்.
- Payment உறுதி Razorpay signature + Razorpay payment status மூலம் சரிபார்க்கப்படுகிறது. UTR எண் மட்டும் வைத்து payment success என்று கருதப்படாது.
- AI கவிதை உருவாக்கம் ஒரு request-ல் மூன்று கவிதைகளைப் பெறும். Payment செய்த Order-ஐ sessionStorage-ல் மீட்டெடுக்க உதவும் தகவல் வைத்திருக்கும்.
- Deploy ஆன பிறகு முதலில் குறைந்த தொகை live test செய்யாமல், Razorpay test mode பயன்படுத்தி அல்லது கட்டுப்படுத்தப்பட்ட live test செய்து Payment, webhook, poem generation, refresh recovery ஆகியவற்றைச் சரிபார்க்க வேண்டும். Live account-ல் உண்மையான ₹14.30 charge ஏற்படும் என்பதை நினைவில் கொள்ளவும்.
