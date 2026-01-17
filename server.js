import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import Stripe from "stripe";
import pg from "pg";

const { Pool } = pg;

const app = express();

// -------------------- ENV (avec fallbacks) --------------------
const PORT = Number(process.env.PORT || 10000);
const NODE_ENV = process.env.NODE_ENV || "production";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const OLYMPEUS_SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN || ""; // optionnel

const DATABASE_URL = process.env.DATABASE_URL || "";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

// accepte les 2 noms (au cas où tu avais une typo)
const STRIPE_PRICE_PREMIUM =
  process.env.STRIPE_PRICE_PREMIUM ||
  process.env.STRIPE_PRICE_PRENIUM ||
  "";

const STRIPE_PRICE_FREE = process.env.STRIPE_PRICE_FREE || ""; // optionnel

const APP_SUCCESS_URL =
  process.env.APP_SUCCESS_URL ||
  process.env.APP_SUCCES_URL || // tolère la typo
  "";

const APP_CANCEL_URL = process.env.APP_CANCEL_URL || "";

const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";

// -------------------- CORE MIDDLEWARE --------------------

// Stripe webhook MUST have RAW body on that route
app.post("/stripe/webhook", bodyParser.raw({ type: "application/json" }));

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Auth optionnel : si token défini, on l’exige
function optionalTokenGuard(req, res, next) {
  if (!OLYMPEUS_SHARED_TOKEN) return next();
  const t = req.headers["x-olympeus-token"];
  if (!t || t !== OLYMPEUS_SHARED_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// -------------------- SAFE SERVICES (ne jamais crasher) --------------------
let pool = null;
async function initDb() {
  if (!DATABASE_URL) {
    console.log("ℹ️ DB disabled (DATABASE_URL missing)");
    return null;
  }
  try {
    const p = new Pool({
      connectionString: DATABASE_URL,
      ssl: NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    });
    await p.query("SELECT 1");
    console.log("✅ DB connected");

    // créer les tables nécessaires si elles n’existent pas (pour éviter erreurs)
    await p.query(`
      CREATE TABLE IF NOT EXISTS public.users (
        id SERIAL PRIMARY KEY,
        wp_user_id INTEGER UNIQUE NOT NULL,
        role TEXT NOT NULL DEFAULT 'free',
        subscription_status TEXT NOT NULL DEFAULT 'inactive',
        stripe_customer_id TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS public.ai_quotas (
        role TEXT PRIMARY KEY,
        chat_per_day INTEGER NOT NULL,
        web_per_day INTEGER NOT NULL,
        max_prompt_chars INTEGER NOT NULL
      );
    `);

    await p.query(`
      INSERT INTO public.ai_quotas(role, chat_per_day, web_per_day, max_prompt_chars)
      VALUES ('free', 10, 3, 4000),
             ('premium', 300, 50, 20000)
      ON CONFLICT (role) DO NOTHING;
    `);

    await p.query(`
      CREATE TABLE IF NOT EXISTS public.ai_usage_daily (
        id SERIAL PRIMARY KEY,
        wp_user_id INTEGER NOT NULL,
        day DATE NOT NULL,
        chat_requests INTEGER NOT NULL DEFAULT 0,
        web_requests INTEGER NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0,
        UNIQUE (wp_user_id, day)
      );
    `);

    return p;
  } catch (e) {
    console.error("⚠️ DB init failed (disabled):", e?.message || e);
    return null;
  }
}

let stripe = null;
function initStripe() {
  if (!STRIPE_SECRET_KEY) {
    console.log("ℹ️ Stripe disabled (STRIPE_SECRET_KEY missing)");
    return null;
  }
  try {
    const s = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
    console.log("✅ Stripe ready");
    return s;
  } catch (e) {
    console.error("⚠️ Stripe init failed (disabled):", e?.message || e);
    return null;
  }
}

// -------------------- HEALTH ROUTES (jamais de 502) --------------------
app.get("/", (req, res) => res.status(200).send("OlympeUS API ✅"));
app.get("/ping", (req, res) => res.status(200).json({ ok: true }));
app.get("/health", async (req, res) => {
  let dbOk = false;
  try {
    if (pool) {
      await pool.query("SELECT 1");
      dbOk = true;
    }
  } catch {
    dbOk = false;
  }
  res.status(200).json({
    ok: true,
    stripe: !!stripe,
    db: dbOk,
    tavily: !!TAVILY_API_KEY,
  });
});

// -------------------- QUOTA HELPERS --------------------
async function ensureUser(wp_user_id) {
  if (!pool) return { role: "free" };

  await pool.query(
    `INSERT INTO public.users (wp_user_id, role, subscription_status)
     VALUES ($1,'free','inactive')
     ON CONFLICT (wp_user_id) DO NOTHING`,
    [Number(wp_user_id)]
  );

  const r = await pool.query(
    `SELECT role, subscription_status, stripe_customer_id
     FROM public.users
     WHERE wp_user_id=$1
     LIMIT 1`,
    [Number(wp_user_id)]
  );
  return r.rows?.[0] || { role: "free" };
}

async function getQuotas(role) {
  if (!pool) {
    return role === "premium"
      ? { chat_per_day: 300, web_per_day: 50, max_prompt_chars: 20000 }
      : { chat_per_day: 10, web_per_day: 3, max_prompt_chars: 4000 };
  }
  const r = await pool.query(
    `SELECT chat_per_day, web_per_day, max_prompt_chars FROM public.ai_quotas WHERE role=$1 LIMIT 1`,
    [role]
  );
  if (r.rows?.[0]) return r.rows[0];
  return role === "premium"
    ? { chat_per_day: 300, web_per_day: 50, max_prompt_chars: 20000 }
    : { chat_per_day: 10, web_per_day: 3, max_prompt_chars: 4000 };
}

async function getTodayUsage(wp_user_id) {
  if (!pool) return { chat_requests: 0, web_requests: 0, tokens: 0 };

  await pool.query(
    `INSERT INTO public.ai_usage_daily (wp_user_id, day, chat_requests, web_requests, tokens)
     VALUES ($1, CURRENT_DATE, 0, 0, 0)
     ON CONFLICT (wp_user_id, day) DO NOTHING`,
    [Number(wp_user_id)]
  );

  const r = await pool.query(
    `SELECT chat_requests, web_requests, tokens
     FROM public.ai_usage_daily
     WHERE wp_user_id=$1 AND day=CURRENT_DATE`,
    [Number(wp_user_id)]
  );
  return r.rows?.[0] || { chat_requests: 0, web_requests: 0, tokens: 0 };
}

async function incChat(wp_user_id, tokens) {
  if (!pool) return;
  await pool.query(
    `UPDATE public.ai_usage_daily
     SET chat_requests = chat_requests + 1,
         tokens = tokens + $2
     WHERE wp_user_id=$1 AND day=CURRENT_DATE`,
    [Number(wp_user_id), Number(tokens || 0)]
  );
}

async function incWeb(wp_user_id) {
  if (!pool) return;
  await pool.query(
    `UPDATE public.ai_usage_daily
     SET web_requests = web_requests + 1
     WHERE wp_user_id=$1 AND day=CURRENT_DATE`,
    [Number(wp_user_id)]
  );
}

// -------------------- TAVILY (only if enabled) --------------------
async function tavilySearch(query) {
  if (!TAVILY_API_KEY) return { used: false, results: [] };
  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        max_results: 5,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
      }),
    });
    if (!resp.ok) throw new Error(`Tavily HTTP ${resp.status}`);
    const data = await resp.json();
    const results = (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      content: (r.content || "").slice(0, 900),
    }));
    return { used: true, results };
  } catch (e) {
    console.error("tavilySearch error:", e?.message || e);
    return { used: false, results: [] };
  }
}

// -------------------- OPENAI (via HTTP, pas de lib) --------------------
async function callOpenAI({ prompt, expert, webContext }) {
  if (!OPENAI_API_KEY) {
    return { text: "Erreur serveur : OPENAI_API_KEY manquante.", tokens: 0 };
  }

  const system = [
    "Tu es OlympeUS, assistant francophone.",
    "Tu tutoies, ton chaleureux et neutre.",
    "Tu n'inventes jamais : si tu ne sais pas, dis-le.",
    expert
      ? "MODE EXPERT : réponse structurée, étapes, recommandations concrètes."
      : "Réponse simple, utile et lisible.",
  ].join("\n");

  const messages = [
    { role: "system", content: system },
    ...(webContext ? [{ role: "system", content: webContext }] : []),
    { role: "user", content: prompt },
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: expert ? 0.25 : 0.7,
      messages,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  return {
    text: data?.choices?.[0]?.message?.content?.trim() || "",
    tokens: data?.usage?.total_tokens || 0,
  };
}

// -------------------- STRIPE: CHECKOUT --------------------
app.post("/stripe/create-checkout-session", optionalTokenGuard, async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ ok: false, error: "stripe_not_configured" });
    if (!STRIPE_PRICE_PREMIUM) return res.status(400).json({ ok: false, error: "missing_STRIPE_PRICE_PREMIUM" });
    if (!APP_SUCCESS_URL || !APP_CANCEL_URL) return res.status(400).json({ ok: false, error: "missing_success_or_cancel_url" });

    const { wp_user_id } = req.body || {};
    if (!wp_user_id) return res.status(400).json({ ok: false, error: "wp_user_id_missing" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_PREMIUM, quantity: 1 }],
      success_url: `${APP_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: APP_CANCEL_URL,
      client_reference_id: String(wp_user_id),
      metadata: { wp_user_id: String(wp_user_id) },
      allow_promotion_codes: true,
    });

    res.json({ ok: true, url: session.url, id: session.id });
  } catch (e) {
    console.error("stripe checkout error:", e?.message || e);
    res.status(500).json({ ok: false, error: "stripe_checkout_failed" });
  }
});

// -------------------- STRIPE: WEBHOOK (upgrade premium) --------------------
app.post("/stripe/webhook", async (req, res) => {
  try {
    if (!stripe) return res.status(200).json({ received: true, stripe: "disabled" });
    if (!STRIPE_WEBHOOK_SECRET) return res.status(400).send("Missing STRIPE_WEBHOOK_SECRET");

    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("webhook signature error:", err?.message || err);
      return res.status(400).send("Webhook signature error");
    }

    // Activer premium
    if (pool && event.type === "checkout.session.completed") {
      const session = event.data.object;
      const wpUser = session?.metadata?.wp_user_id || session?.client_reference_id;
      const customerId = session?.customer || null;

      if (wpUser) {
        await pool.query(
          `INSERT INTO public.users (wp_user_id, role, subscription_status, stripe_customer_id)
           VALUES ($1,'premium','active',$2)
           ON CONFLICT (wp_user_id)
           DO UPDATE SET role='premium', subscription_status='active', stripe_customer_id=EXCLUDED.stripe_customer_id`,
          [Number(wpUser), customerId]
        );
      }
    }

    // Downgrade si abonnement supprimé (si on peut mapper via customer)
    if (pool && event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const customerId = sub?.customer;
      if (customerId) {
        await pool.query(
          `UPDATE public.users SET role='free', subscription_status='canceled'
           WHERE stripe_customer_id=$1`,
          [customerId]
        );
      }
    }

    console.log("✅ webhook:", event.type);
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("webhook error:", e?.message || e);
    // Important: répondre 200 pour éviter les retries infinis Stripe
    return res.status(200).json({ received: true, ok: false });
  }
});

// -------------------- AI: quotas + web optional + tracking --------------------
async function handleAssist(req, res) {
  try {
    const { wp_user_id, prompt, expert = false, web = { enabled: false, query: "" } } = req.body || {};

    if (!wp_user_id) return res.status(400).json({ ok: false, error: "wp_user_id_missing" });
    if (!prompt || String(prompt).trim().length === 0) return res.status(400).json({ ok: false, error: "prompt_missing" });

    const user = await ensureUser(wp_user_id);
    const role = user?.role || "free";
    const quotas = await getQuotas(role);

    const p = String(prompt);
    if (p.length > Number(quotas.max_prompt_chars)) {
      return res.status(429).json({
        ok: false,
        error: "prompt_too_long",
        message: `Texte trop long (${p.length}). Limite: ${quotas.max_prompt_chars}.`,
        role,
      });
    }

    const usage = await getTodayUsage(wp_user_id);
    if (Number(usage.chat_requests) >= Number(quotas.chat_per_day)) {
      return res.status(429).json({
        ok: false,
        error: "quota_reached",
        message: `Quota atteint (${quotas.chat_per_day}/jour). Passe Premium pour augmenter tes limites.`,
        role,
        quota: { ...quotas, used: usage },
      });
    }

    // Web search only if enabled AND query ok AND web quota ok
    const wantWeb =
      Boolean(web?.enabled) && String(web?.query || "").trim().length >= 3;

    let citations = [];
    let webContext = "";

    if (wantWeb && Number(usage.web_requests) < Number(quotas.web_per_day)) {
      const t = await tavilySearch(String(web.query));
      await incWeb(wp_user_id);

      if (t.used && t.results.length) {
        citations = t.results.map((r, i) => ({ id: i + 1, title: r.title, url: r.url }));
        const blocks = t.results
          .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nExtrait: ${r.content}`)
          .join("\n\n");
        webContext =
          `Contexte web (si utile, sinon ignore). ` +
          `Si tu t'appuies dessus, cite [1], [2], etc.\n\n${blocks}`;
      }
    }

    const { text, tokens } = await callOpenAI({
      prompt: p,
      expert: Boolean(expert),
      webContext,
    });

    await incChat(wp_user_id, tokens);

    return res.status(200).json({
      ok: true,
      role,
      answer: text,
      citations,
    });
  } catch (e) {
    console.error("assist error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "post-assist-failed" });
  }
}

// L’endpoint principal + alias (selon ton snippet)
app.post("/post-assist", optionalTokenGuard, handleAssist);
app.post("/com-post-assist", optionalTokenGuard, handleAssist);

// -------------------- 404 + ERROR HANDLER --------------------
app.use((req, res) => res.status(404).json({ ok: false, error: "not_found" }));
app.use((err, req, res, next) => {
  console.error("UNHANDLED:", err?.message || err);
  res.status(500).json({ ok: false, error: "server_error" });
});

// -------------------- START --------------------
(async () => {
  pool = await initDb();
  stripe = initStripe();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Server running on port ${PORT}`);
  });
})();
