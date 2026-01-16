import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import Stripe from "stripe";
import pg from "pg";

const { Pool } = pg;

/* =========================
   CONFIG
========================= */

const PORT = process.env.PORT || 10000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* =========================
   APP
========================= */

const app = express();

/* Stripe webhook needs raw body */
app.use(
  "/stripe/webhook",
  bodyParser.raw({ type: "application/json" })
);

app.use(cors());
app.use(express.json());

/* =========================
   HEALTHCHECK
========================= */

app.get("/ping", (req, res) => {
  res.json({ ok: true });
});

/* =========================
   STRIPE CHECKOUT
========================= */

app.post("/stripe/checkout", async (req, res) => {
  try {
    const { priceId, userId } = req.body;

    if (!priceId || !userId) {
      return res.status(400).json({ error: "Missing priceId or userId" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      success_url: "https://olympeus-ai.onrender.com/success",
      cancel_url: "https://olympeus-ai.onrender.com/cancel",
      metadata: {
        userId
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ error: "Stripe checkout failed" });
  }
});

/* =========================
   STRIPE WEBHOOK
========================= */

app.post("/stripe/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const userId = session.metadata.userId;
      const customerId = session.customer;

      await pool.query(
        `
        UPDATE users
        SET role = 'premium',
            stripe_customer_id = $1,
            subscription_status = 'active'
        WHERE wp_user_id = $2
        `,
        [customerId, userId]
      );
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(500).json({ error: "Webhook failed" });
  }
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
