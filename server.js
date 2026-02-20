require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const nodemailer = require('nodemailer');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const oracleQueue = new Queue('oracle-readings', { connection });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

app.post('/create-checkout-session', express.json(), async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Mystic Oracle Reading' }, unit_amount: 999 }, quantity: 1 }],
            mode: 'payment',
            success_url: 'http://localhost:3000/success.html', 
            cancel_url: 'http://localhost:3000/cancel.html',
            metadata: req.body
        });
        res.json({ url: session.url });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        await oracleQueue.add('generate-reading', session.metadata, { delay: 60000, attempts: 3 }); // 1 minute delay for testing
    }
    res.json({ received: true });
});

const worker = new Worker('oracle-readings', async job => {
    const { name, email, zodiac, birthplace, question } = job.data;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Act as a mystic fortune teller. A user named ${name}, a ${zodiac} born in ${birthplace}, asked: "${question}". Write a mysterious, positive 3-paragraph fortune.`;
    
    const result = await model.generateContent(prompt);
    const readingText = result.response.text();

    await transporter.sendMail({
        from: '"The Digital Oracle" <oracle@yourdomain.com>',
        to: email,
        subject: '🔮 The Spirits Have Answered',
        html: `<p>The Veil Parts, ${name}...</p><p>${readingText}</p>`
    });
}, { connection });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Oracle Backend listening on port ${PORT}`));
