import express from "express";
import cors from "cors";
import pg from "pg";
import Stripe from "stripe";
import OpenAI from "openai";

const app = express();

// --- Stripe webhook needs RAW body ---
app.post("/stripe/webhook", express.raw({ type: "application/json" }));

// --- JSON for everything else ---
app.use(express.json({ limit: "2mb" }));
app.use(cors());

const {
  OPENAI_API_KEY,
  OLYMPEUS_SHARED_TOKEN,
  DATABASE_URL,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_ID_PREMIUM,
  TAVILY_API_KEY,
  ADMIN_TOKEN,
  APP_SUCCESS_URL,
  APP_CANCEL_URL,
} = process.env;

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes("render.com") ? { rejectUnauthorized: false } : undefined,
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

function requireSharedToken(req, res, next) {
  const t = req.headers["x-olympeus-token"];
  if (!t || t !== OLYMPEUS_SHARED_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/", (req, res) => res.send("OlympeUS AI API is running ✅"));
app.get("/ping", (req, res) => res.json({ ok: true }));

// ---------------- DB helpers ----------------
async function getOrCreateUser(wp_user_id) {
  const r = await pool.query(
    `INSERT INTO public.users (wp_user_id, role, subscription_status, created_at)
     VALUES ($1, 'free', 'inactive', NOW())
     ON CONFLICT (wp_user_id) DO UPDATE SET wp_user_id = EXCLUDED.wp_user_id
     RETURNING *`,
    [wp_user_id]
  );
  return r.rows[0];
}

async function getQuotaForRole(role) {
  const r = await pool.query(`SELECT * FROM public.quotas WHERE role=$1`, [role]);
  return r.rows[0] || { chat_per_day: 30, tavily_per_day: 5, memory_turns: 12 };
}

async function countToday(user_id, endpoint) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM public.request_logs
     WHERE user_id=$1 AND endpoint=$2 AND created_at::date = CURRENT_DATE`,
    [user_id, endpoint]
  );
  return r.rows[0].n;
}

async function logRequest({ user_id, endpoint, tokens = 0, model = null, ok = true }) {
  await pool.query(
    `INSERT INTO public.request_logs (user_id, endpoint, tokens, model, ok, created_at)
     VALUES ($1,$2,$3,$4,$5,NOW())`,
    [user_id, endpoint, tokens, model, ok]
  );
}

async function getOrCreateConversation(user_id, conversation_id) {
  if (conversation_id) {
    const r = await pool.query(
      `SELECT * FROM public.conversations WHERE id=$1 AND user_id=$2`,
      [conversation_id, user_id]
    );
    if (r.rows.length) return r.rows[0];
  }
  const created = await pool.query(
    `INSERT INTO public.conversations (user_id, created_at) VALUES ($1,NOW()) RETURNING *`,
    [user_id]
  );
  return created.rows[0];
}

async function loadMemory(conversation_id, limitTurns) {
  const r = await pool.query(
    `SELECT role, content
     FROM public.messages
     WHERE conversation_id=$1
     ORDER BY id DESC
     LIMIT $2`,
    [conversation_id, limitTurns * 2] // user+assistant pairs
  );
  return r.rows.reverse();
}

async function saveTurn(conversation_id, role, content) {
  await pool.query(
    `INSERT INTO public.messages (conversation_id, role, content, created_at)
     VALUES ($1,$2,$3,NOW())`,
    [conversation_id, role, content]
  );
}

// ---------------- Tavily (only if enabled) ----------------
async function tavilySearch(query) {
  if (!TAVILY_API_KEY) return { results: [] };

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

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Tavily error: ${resp.status} ${txt}`);
  }

  const data = await resp.json();
  const results = (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    content: (r.content || "").slice(0, 700),
  }));
  return { results };
}

function buildSystemPrompt({ expert }) {
  const base = [
    "Tu es OlympeUS, assistant francophone.",
    "Tu tutoies, ton chaleureux et neutre.",
    "Tu n’inventes jamais des faits.",
    "Si une info n’est pas certaine, tu le dis clairement et tu proposes de vérifier.",
  ];
  const expertMode = expert
    ? [
        "MODE EXPERT : réponses structurées, étapes, recommandations concrètes.",
        "Quand tu utilises le contexte web, appuie-toi dessus et reste prudent.",
      ]
    : ["Réponses simples, utiles, lisibles."];

  return [...base, ...expertMode].join("\n");
}

function buildWebContext(results) {
  if (!results.length) return "";
  const lines = results.map((r, i) => {
    const n = i + 1;
    return `[${n}] ${r.title}\nURL: ${r.url}\nExtrait: ${r.content}`;
  });
  return `CONTEXTE WEB (si pertinent, sinon ignorer):\n${lines.join("\n\n")}`;
}

// ---------------- Stripe: Checkout & Webhook ----------------

// Create Checkout Session
app.post("/stripe/checkout", requireSharedToken, async (req, res) => {
  try {
    const { wp_user_id } = req.body || {};
    if (!wp_user_id) return res.status(400).json({ error: "wp_user_id required" });

    const user = await getOrCreateUser(Number(wp_user_id));

    // create / reuse customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { wp_user_id: String(wp_user_id) },
      });
      customerId = customer.id;
      await pool.query(`UPDATE public.users SET stripe_customer_id=$1 WHERE id=$2`, [customerId, user.id]);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: STRIPE_PRICE_ID_PREMIUM, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: APP_SUCCESS_URL || "https://example.com/?olympeus=success",
      cancel_url: APP_CANCEL_URL || "https://example.com/?olympeus=cancel",
    });

    await logRequest({ user_id: user.id, endpoint: "stripe", ok: true });

    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: "stripe_checkout_failed" });
  }
});

// Webhook
app.post("/stripe/webhook", async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);

    async function setByCustomer(customerId, patch) {
      const keys = Object.keys(patch);
      const vals = Object.values(patch);
      const setSql = keys.map((k, i) => `${k}=$${i + 1}`).join(", ");
      await pool.query(
        `UPDATE public.users SET ${setSql} WHERE stripe_customer_id=$${keys.length + 1}`,
        [...vals, customerId]
      );
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      if (session.customer) {
        await setByCustomer(session.customer, {
          role: "premium",
          subscription_status: "active",
        });
      }
    }

    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const status = sub.status || "active";
      const role = (status === "active" || status === "trialing") ? "premium" : "free";
      const priceId = sub.items?.data?.[0]?.price?.id || null;
      const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;

      await setByCustomer(sub.customer, {
        role,
        subscription_status: status,
        stripe_subscription_id: sub.id,
        stripe_price_id: priceId,
        current_period_end: periodEnd,
      });
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      await setByCustomer(sub.customer, {
        role: "free",
        subscription_status: "canceled",
        stripe_subscription_id: sub.id,
        stripe_price_id: null,
        current_period_end: null,
      });
    }

    res.json({ received: true });
  } catch (e) {
    res.status(400).send("Webhook Error");
  }
});

// Admin dashboard JSON
app.get("/admin/usage", async (req, res) => {
  try {
    if (!ADMIN_TOKEN || req.headers["x-admin-token"] !== ADMIN_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const r = await pool.query(
      `SELECT u.wp_user_id, u.role, u.subscription_status,
              (SELECT COUNT(*) FROM request_logs rl WHERE rl.user_id=u.id AND rl.endpoint='chat' AND rl.created_at::date=CURRENT_DATE) AS chat_today,
              (SELECT COUNT(*) FROM request_logs rl WHERE rl.user_id=u.id AND rl.endpoint='tavily' AND rl.created_at::date=CURRENT_DATE) AS web_today,
              (SELECT COALESCE(SUM(tokens),0) FROM request_logs rl WHERE rl.user_id=u.id AND rl.endpoint='chat' AND rl.created_at::date=CURRENT_DATE) AS tokens_today
       FROM users u
       ORDER BY tokens_today DESC NULLS LAST
       LIMIT 200`
    );
    res.json({ day: new Date().toISOString().slice(0, 10), users: r.rows });
  } catch (e) {
    res.status(500).json({ error: "admin_failed" });
  }
});

// ---------------- Main AI endpoint ----------------
app.post("/post-assist", requireSharedToken, async (req, res) => {
  try {
    const {
      wp_user_id,
      conversation_id,
      mode = "chat",
      draft = "",
      expert = false,
      web = { enabled: false, query: "" },
    } = req.body || {};

    if (!wp_user_id) return res.status(400).json({ error: "wp_user_id required" });

    const user = await getOrCreateUser(Number(wp_user_id));
    const quota = await getQuotaForRole(user.role || "free");

    // quota chat/day
    const chatToday = await countToday(user.id, "chat");
    if (chatToday >= quota.chat_per_day) {
      return res.status(429).json({ error: "Quota journalier atteint. Passe Premium pour augmenter tes limites." });
    }

    const conv = await getOrCreateConversation(user.id, conversation_id);
    const memory = await loadMemory(conv.id, quota.memory_turns);

    // Tavily only if user requested
    let citations = [];
    let webContext = "";
    const wantWeb = Boolean(web?.enabled && String(web?.query || "").trim().length >= 3);

    if (wantWeb) {
      const webToday = await countToday(user.id, "tavily");
      if (webToday < quota.tavily_per_day) {
        const t = await tavilySearch(String(web.query));
        citations = (t.results || []).map((r, i) => ({ id: i + 1, title: r.title, url: r.url }));
        webContext = buildWebContext(t.results || []);
        await logRequest({ user_id: user.id, endpoint: "tavily", ok: true, model: "tavily" });
      }
    }

    const system = buildSystemPrompt({ expert });

    // Instruction par mode (améliore la qualité)
    const task =
      mode === "ideas"
        ? "Donne 10 idées concrètes + 3 angles originaux + 3 titres."
        : mode === "improve"
        ? "Propose 2 versions améliorées (courte et longue) + corrections orthographe."
        : mode === "summary"
        ? "Fais un résumé en 3 lignes puis une synthèse structurée."
        : "Réponds de façon utile et conversationnelle.";

    const userMsg = `TÂCHE: ${task}\n\nTEXTE:\n${draft}`;

    const messages = [
      { role: "system", content: system },
      ...memory,
      ...(webContext ? [{ role: "system", content: webContext }] : []),
      { role: "user", content: userMsg },
    ];

    const model = "gpt-4.1-mini";

    const completion = await openai.chat.completions.create({
      model,
      messages,
      temperature: expert ? 0.35 : 0.7,
    });

    const text = completion.choices?.[0]?.message?.content?.trim() || "";
    const tokens = completion.usage?.total_tokens || 0;

    // save memory (true multi-turn)
    await saveTurn(conv.id, "user", userMsg);
    await saveTurn(conv.id, "assistant", text);

    await logRequest({ user_id: user.id, endpoint: "chat", ok: true, model, tokens });

    return res.json({
      ok: true,
      conversation_id: conv.id,
      text,
      citations,
    });
  } catch (e) {
    return res.status(500).json({ error: "post-assist-failed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Listening on", PORT));
