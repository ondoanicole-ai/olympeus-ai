import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import Stripe from "stripe";
import pg from "pg";

const { Pool } = pg;

const app = express();

// -------------------- ENV --------------------
const PORT = Number(process.env.PORT || 10000);
const NODE_ENV = process.env.NODE_ENV || "production";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_PREMIUM = process.env.STRIPE_PRICE_PREMIUM || "";
const STRIPE_PRICE_FREE = process.env.STRIPE_PRICE_FREE || ""; // optionnel

const APP_SUCCESS_URL = process.env.APP_SUCCESS_URL || process.env.APP_SUCCES_URL || "";
const APP_CANCEL_URL = process.env.APP_CANCEL_URL || "";

const DATABASE_URL = process.env.DATABASE_URL || "";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";

// -------------------- SAFE BOOT (never crash) --------------------
let stripe = null;
try {
  if (STRIPE_SECRET_KEY) {
    stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
    console.log("✅ Stripe ready");
  } else {
    console.log("ℹ️ Stripe disabled (missing STRIPE_SECRET_KEY)");
  }
} catch (e) {
  console.error("⚠️ Stripe init failed:", e?.message || e);
  stripe = null;
}

let pool = null;
try {
  if (DATABASE_URL) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    });
    console.log("✅ Postgres pool created");
  } else {
    console.log("ℹ️ Postgres disabled (missing DATABASE_URL)");
  }
} catch (e) {
  console.error("⚠️ Postgres init failed:", e?.message || e);
  pool = null;
}

// -------------------- MIDDLEWARE --------------------
// Stripe webhook needs RAW body ONLY on that route:
app.post("/stripe/webhook", bodyParser.raw({ type: "application/json" }));

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// -------------------- HEALTH ROUTES (must never fail) --------------------
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

// -------------------- HELPERS --------------------
function safe(res, code, obj) {
  try {
    return res.status(code).json(obj);
  } catch {
    return res.status(code).send("OK");
  }
}

async function getUserRole(wp_user_id) {
  // fallback = free si pas de DB
  if (!pool || !wp_user_id) return "free";
  try {
    await pool.query(
      `INSERT INTO users (wp_user_id, role, subscription_status)
       VALUES ($1,'free','inactive')
       ON CONFLICT (wp_user_id) DO NOTHING`,
      [Number(wp_user_id)]
    );
    const r = await pool.query(`SELECT role FROM users WHERE wp_user_id=$1 LIMIT 1`, [Number(wp_user_id)]);
    return r.rows?.[0]?.role || "free";
  } catch (e) {
    console.error("getUserRole error:", e?.message || e);
    return "free";
  }
}

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

async function callOpenAI({ prompt, expert, webContext }) {
  if (!OPENAI_API_KEY) {
    return { text: "Erreur serveur : OPENAI_API_KEY manquante.", tokens: 0 };
  }

  const system = [
    "Tu es OlympeUS, assistant francophone.",
    "Tu tutoies, ton chaleureux et neutre.",
    "Tu n'inventes jamais. Si tu ne sais pas, dis-le.",
    expert ? "MODE EXPERT : réponse structurée, étapes, recommandations concrètes." : "Réponse simple, utile et lisible.",
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
app.post("/stripe/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) return safe(res, 400, { error: "Stripe not configured" });
    if (!STRIPE_PRICE_PREMIUM) return safe(res, 400, { error: "Missing STRIPE_PRICE_PREMIUM" });
    if (!APP_SUCCESS_URL || !APP_CANCEL_URL) return safe(res, 400, { error: "Missing APP_SUCCESS_URL / APP_CANCEL_URL" });

    const { wp_user_id } = req.body || {};
    if (!wp_user_id) return safe(res, 400, { error: "wp_user_id missing" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_PREMIUM, quantity: 1 }],
      success_url: `${APP_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: APP_CANCEL_URL,
      client_reference_id: String(wp_user_id),
      metadata: { wp_user_id: String(wp_user_id) },
      allow_promotion_codes: true,
    });

    return safe(res, 200, { url: session.url, id: session.id });
  } catch (e) {
    console.error("checkout error:", e?.message || e);
    return safe(res, 500, { error: "stripe_checkout_failed" });
  }
});

// -------------------- STRIPE: WEBHOOK --------------------
app.post("/stripe/webhook", async (req, res) => {
  try {
    if (!stripe) return safe(res, 200, { ok: true, stripe: "disabled" });
    if (!STRIPE_WEBHOOK_SECRET) return safe(res, 400, { error: "Missing STRIPE_WEBHOOK_SECRET" });

    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("webhook signature error:", err?.message || err);
      return res.status(400).send("Webhook signature error");
    }

    // Upgrade/downgrade user role via wp_user_id in metadata or client_reference_id
    if (pool) {
      try {
        if (event.type === "checkout.session.completed") {
          const session = event.data.object;
          const wpUser = session?.metadata?.wp_user_id || session?.client_reference_id;
          if (wpUser) {
            await pool.query(
              `INSERT INTO users (wp_user_id, role, subscription_status, stripe_customer_id)
               VALUES ($1,'premium','active',$2)
               ON CONFLICT (wp_user_id) DO UPDATE SET role='premium', subscription_status='active', stripe_customer_id=EXCLUDED.stripe_customer_id`,
              [Number(wpUser), session.customer || null]
            );
          }
        }

        if (event.type === "customer.subscription.deleted") {
          const sub = event.data.object;
          // On ne sait pas toujours le wp_user_id ici: pour du full robuste, on map via stripe_customer_id.
          if (sub.customer) {
            await pool.query(
              `UPDATE users SET role='free', subscription_status='canceled'
               WHERE stripe_customer_id=$1`,
              [sub.customer]
            );
          }
        }
      } catch (e) {
        console.error("webhook db update error:", e?.message || e);
        // On répond OK à Stripe quand même pour éviter les retries infinis
      }
    }

    console.log("✅ webhook:", event.type);
    return safe(res, 200, { received: true });
  } catch (e) {
    console.error("webhook error:", e?.message || e);
    return safe(res, 200, { received: true }); // ne pas faire échouer Stripe
  }
});

// -------------------- AI ENDPOINT --------------------
app.post("/post-assist", async (req, res) => {
  try {
    const { prompt, wp_user_id, expert = false, web = { enabled: false, query: "" } } = req.body || {};
    if (!prompt || String(prompt).trim().length === 0) return safe(res, 400, { error: "prompt missing" });
    if (!wp_user_id) return safe(res, 400, { error: "wp_user_id missing" });

    // ----- 1) Récupérer rôle + quotas -----
    let role = "free";
    let quotas = { chat_per_day: 10, web_per_day: 3, max_prompt_chars: 4000 };

    if (pool) {
      // user row
      await pool.query(
        `INSERT INTO users (wp_user_id, role, subscription_status)
         VALUES ($1,'free','inactive')
         ON CONFLICT (wp_user_id) DO NOTHING`,
        [Number(wp_user_id)]
      );

      const rRole = await pool.query(`SELECT role FROM users WHERE wp_user_id=$1 LIMIT 1`, [Number(wp_user_id)]);
      role = rRole.rows?.[0]?.role || "free";

      const rQ = await pool.query(`SELECT chat_per_day, web_per_day, max_prompt_chars FROM ai_quotas WHERE role=$1`, [
        role,
      ]);
      if (rQ.rows?.[0]) quotas = rQ.rows[0];
    }

    // ----- 2) Vérifier limites prompt -----
    const p = String(prompt);
    if (p.length > Number(quotas.max_prompt_chars)) {
      return safe(res, 429, {
        error: `Limite free/premium atteinte : texte trop long (${p.length} caractères).`,
      });
    }

    // ----- 3) Compter usage du jour + bloquer si quota dépassé -----
    let todayUsage = { chat_requests: 0, web_requests: 0, tokens: 0 };

    if (pool) {
      await pool.query(
        `INSERT INTO ai_usage_daily (wp_user_id, day, chat_requests, web_requests, tokens)
         VALUES ($1, CURRENT_DATE, 0, 0, 0)
         ON CONFLICT (wp_user_id, day) DO NOTHING`,
        [Number(wp_user_id)]
      );

      const rU = await pool.query(
        `SELECT chat_requests, web_requests, tokens
         FROM ai_usage_daily
         WHERE wp_user_id=$1 AND day=CURRENT_DATE`,
        [Number(wp_user_id)]
      );
      if (rU.rows?.[0]) todayUsage = rU.rows[0];

      if (Number(todayUsage.chat_requests) >= Number(quotas.chat_per_day)) {
        return safe(res, 429, {
          error: `Quota journalier atteint (${quotas.chat_per_day} requêtes/jour). Passe Premium pour augmenter tes limites.`,
          role,
          quota: { ...quotas, used: todayUsage },
        });
      }
    } else {
      // Sans DB, on ne peut pas compter : on laisse passer (mais tu as la DB donc OK)
    }

    // ----- 4) Tavily uniquement si demandé ET quota web ok -----
    let citations = [];
    let webContext = "";
    const wantWeb = Boolean(web?.enabled) && String(web?.query || "").trim().length >= 3;

    if (wantWeb) {
      if (pool && Number(todayUsage.web_requests) >= Number(quotas.web_per_day)) {
        // On n’échoue pas l’IA : on désactive juste le web
        // (comme ça l’utilisateur a une réponse quand même)
      } else {
        const t = await tavilySearch(String(web.query));
        if (t.used && t.results.length) {
          citations = t.results.map((r, i) => ({ id: i + 1, title: r.title, url: r.url }));
          const blocks = t.results
            .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nExtrait: ${r.content}`)
            .join("\n\n");
          webContext =
            `Contexte web (si utile, sinon ignore). ` +
            `Si tu t'appuies dessus, cite [1], [2], etc.\n\n${blocks}`;
        }

        // incrémente web_requests si on a tenté une recherche
        if (pool) {
          await pool.query(
            `UPDATE ai_usage_daily
             SET web_requests = web_requests + 1
             WHERE wp_user_id=$1 AND day=CURRENT_DATE`,
            [Number(wp_user_id)]
          );
        }
      }
    }

    // ----- 5) Appel OpenAI -----
    const { text, tokens } = await callOpenAI({
      prompt: p,
      expert: Boolean(expert),
      webContext,
    });

    // ----- 6) Incrémenter chat_requests + tokens -----
    if (pool) {
      await pool.query(
        `UPDATE ai_usage_daily
         SET chat_requests = chat_requests + 1,
             tokens = tokens + $2
         WHERE wp_user_id=$1 AND day=CURRENT_DATE`,
        [Number(wp_user_id), Number(tokens || 0)]
      );
    }

    return safe(res, 200, {
      ok: true,
      role,
      answer: text,
      citations,
      quota: {
        ...quotas,
        used: pool
          ? {
              chat_requests: Number(todayUsage.chat_requests) + 1,
              web_requests: Number(todayUsage.web_requests) + (wantWeb ? 1 : 0),
              tokens: Number(todayUsage.tokens) + Number(tokens || 0),
            }
          : null,
      },
    });
  } catch (e) {
    console.error("post-assist error:", e?.message || e);
    return safe(res, 500, { error: "post-assist-failed" });
  }
});

    // Tavily uniquement si demandé
    let citations = [];
    let webContext = "";
    const wantWeb = Boolean(web?.enabled) && String(web?.query || "").trim().length >= 3;

    if (wantWeb) {
      const t = await tavilySearch(String(web.query));
      if (t.used && t.results.length) {
        citations = t.results.map((r, i) => ({ id: i + 1, title: r.title, url: r.url }));
        const blocks = t.results
          .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nExtrait: ${r.content}`)
          .join("\n\n");
        webContext = `Contexte web (si utile, sinon ignore). Si tu t'appuies dessus, cite [1], [2], etc.\n\n${blocks}`;
      }
    }

    const { text } = await callOpenAI({
      prompt: String(prompt),
      expert: Boolean(expert),
      webContext,
    });

    return safe(res, 200, {
      ok: true,
      role,
      answer: text,
      citations,
    });
  } catch (e) {
    console.error("post-assist error:", e?.message || e);
    return safe(res, 500, { error: "post-assist-failed" });
  }
});

// -------------------- 404 --------------------
app.use((req, res) => safe(res, 404, { error: "not_found" }));

// -------------------- START --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});
