import express from "express";
import cors from "cors";

const app = express();

/**
 * ENV attendues sur Render :
 * - OPENAI_API_KEY
 * - OLYMPEUS_SHARED_TOKEN
 * - ALLOWED_ORIGIN   (ex: https://olympe-us.com)  (optionnel mais recommandé)
 * - MODEL            (ex: gpt-4o)
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const MODEL = process.env.MODEL || "gpt-4o";

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY manquante (Render env).");
}
if (!SHARED_TOKEN) {
  console.error("❌ OLYMPEUS_SHARED_TOKEN manquant (Render env).");
}

app.use(express.json({ limit: "1mb" }));

// CORS (si ALLOWED_ORIGIN vide, on autorise tout - pas recommandé en prod)
app.use(
  cors({
    origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN : true,
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-olympeus-token"],
  })
);

// --- A2 : mini mémoire en RAM par conversationId ---
const memory = new Map(); // conversationId => [{role, content}, ...]
const MAX_TURNS = 12;

// --- B2 : rate-limit simple (RAM) ---
const hits = new Map(); // ip => {count, resetAt}
const WINDOW_MS = 60_000; // 1 min
const MAX_REQ_PER_WINDOW = 30;

function rateLimit(req, res, next) {
  const ip =
    (req.headers["x-forwarded-for"]?.toString().split(",")[0] || "").trim() ||
    req.socket.remoteAddress ||
    "unknown";

  const now = Date.now();
  const rec = hits.get(ip);

  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }

  rec.count += 1;
  if (rec.count > MAX_REQ_PER_WINDOW) {
    return res.status(429).json({ ok: false, error: "rate_limited" });
  }
  return next();
}

// --- B1 : middleware sécurité token ---
function requireSharedToken(req, res, next) {
  const token = req.header("x-olympeus-token") || "";
  if (!SHARED_TOKEN || token !== SHARED_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  return next();
}

// Ping
app.get("/", (req, res) => {
  res.status(200).send("Olympeus API OK");
});

/**
 * Endpoint appelé par WordPress (proxy)
 */
app.post("/post-assist", rateLimit, requireSharedToken, async (req, res) => {
  try {
    const { message, conversationId } = req.body || {};

    // --- B2 validation ---
    const msg = (message ?? "").toString().trim();
    if (!msg) {
      return res.status(400).json({ ok: false, error: "missing_message" });
    }
    if (msg.length > 2000) {
      return res.status(400).json({ ok: false, error: "message_too_long" });
    }

    // conversationId : si absent, on en crée un
    const convId = (conversationId ?? "").toString().trim() || `c_${Date.now()}`;

    // --- A1 : system prompt pro ---
    const systemPrompt = `
Tu es "Olympeus AI", assistant francophone spécialisé en droit (priorité : droit administratif).
Règles :
- Réponds en français, clairement, sans jargon inutile.
- Structure la réponse (phrases courtes, si utile : puces).
- Si l'utilisateur demande "3 lignes", fais exactement ~3 lignes.
- Ne mens jamais : si tu n'es pas sûr, dis-le.
- Pas de conseil juridique personnalisé : formule en information générale et recommande un professionnel si nécessaire.
`.trim();

    // --- A2 : mémoire courte ---
    const history = memory.get(convId) || [];
    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: msg },
    ];

    // Appel OpenAI (endpoint compat)
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL, // ex: "gpt-4o"
        temperature: 0.4,
        max_tokens: 350,
        messages,
      }),
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      // B3 : log propre (sans secrets)
      console.error("❌ OpenAI error:", r.status, data?.error?.message || data);
      return res.status(502).json({
        ok: false,
        error: "upstream_openai_error",
        details: data?.error?.message || "unknown",
      });
    }

    const answer =
      data?.choices?.[0]?.message?.content?.trim() || "(Réponse vide)";

    // Mise à jour mémoire
    const newHistory = [
      ...history,
      { role: "user", content: msg },
      { role: "assistant", content: answer },
    ].slice(-MAX_TURNS);

    memory.set(convId, newHistory);

    return res.json({
      ok: true,
      answer,
      conversationId: convId,
    });
  } catch (err) {
    console.error("❌ Server error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Olympeus AI server running on port ${PORT}`);
});
