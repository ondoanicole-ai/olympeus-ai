import express from "express";
import helmet from "helmet";
import cors from "cors";

// Node 22 => fetch est natif (pas besoin de node-fetch)

// ===============================
// CONFIG ENV (Render)
// ===============================
const PORT = process.env.PORT || 10000;

// Sécurité : token partagé WP -> Render (header x-olympeus-token)
const SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN || "";

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Rate limit simple (mémoire) — suffisant pour commencer
const RATE_LIMIT_PER_IP_PER_DAY = Number(process.env.RATE_LIMIT_PER_IP_PER_DAY || 20);

// ===============================
// APP
// ===============================
const app = express();

app.use(helmet());

// Comme WP appelle Render côté serveur (wp_remote_post), CORS n'est pas indispensable.
// Mais on laisse en "safe" (au cas où tu testes direct depuis navigateur).
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

app.use(express.json({ limit: "1mb" }));

// ===============================
// RATE LIMIT (simple mémoire)
// ===============================
const ipCounters = new Map(); // key = `${yyyy-mm-dd}:${ip}` => count

function getDayKey() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function rateLimitMiddleware(req, res, next) {
  const day = getDayKey();
  const ip =
    (req.headers["x-forwarded-for"] || "")
      .toString()
      .split(",")[0]
      .trim() ||
    req.socket.remoteAddress ||
    "unknown";

  const key = `${day}:${ip}`;
  const count = ipCounters.get(key) || 0;

  if (count >= RATE_LIMIT_PER_IP_PER_DAY) {
    return res.status(429).json({
      ok: false,
      error: "free_limit_reached",
      limit: RATE_LIMIT_PER_IP_PER_DAY,
    });
  }

  ipCounters.set(key, count + 1);
  next();
}

// ===============================
// AUTH (token partagé)
// ===============================
function requireSharedToken(req, res, next) {
  // Header envoyé par WP : x-olympeus-token
  const token =
    (req.headers["x-olympeus-token"] || req.headers["X-Olymp eus-Token"] || "")
      .toString()
      .trim();

  // Si tu n’as pas encore mis de token côté Render, on refuse (sinon n’importe qui peut appeler)
  if (!SHARED_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "server_misconfigured_missing_shared_token",
    });
  }

  if (!token || token !== SHARED_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  next();
}

// ===============================
// HEALTHCHECK
// ===============================
app.get("/", (req, res) => {
  res.status(200).send("Olympeus API OK ✅");
});

// ===============================
// MAIN ENDPOINT
// ===============================
app.post("/post-assist", requireSharedToken, rateLimitMiddleware, async (req, res) => {
  try {
    // 1) Validation input
    const body = req.body || {};
    const message = typeof body.message === "string" ? body.message.trim() : "";

    // options envoyées depuis WP (facultatif)
    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId : null;

    const expert = !!body.expert;
    const webEnabled = !!(body.web && body.web.enabled);

    if (!message) {
      return res.status(400).json({ ok: false, error: "missing_message" });
    }

    // 2) Vérif OpenAI key
    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "server_misconfigured_missing_openai_key",
      });
    }

    // 3) Construire le prompt (simple + propre)
    const systemParts = [
      "Tu es Olympeus AI, un assistant utile et fiable.",
      "Réponds en français sauf si l'utilisateur demande une autre langue.",
      expert ? "Mode expert: réponse plus structurée, plus détaillée, avec définitions si utile." : "Mode standard: réponse courte et claire.",
      webEnabled ? "Note: la recherche web est demandée, mais si aucune source n'est fournie, indique que tu réponds sans navigation." : "",
    ].filter(Boolean);

    const messages = [
      { role: "system", content: systemParts.join(" ") },
      { role: "user", content: message },
    ];

    // 4) Appel OpenAI (Chat Completions)
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: expert ? 0.4 : 0.7,
      }),
    });

    const data = await resp.json().catch(() => null);

    if (!resp.ok) {
      // Log côté serveur (Render)
      console.error("OpenAI error:", resp.status, data);
      return res.status(502).json({
        ok: false,
        error: "upstream_openai_error",
        status: resp.status,
      });
    }

    const answer =
      data?.choices?.[0]?.message?.content?.trim() ||
      "Réponse vide (OpenAI).";

    // 5) Réponse vers WP
    return res.json({
      ok: true,
      answer,
      conversationId: conversationId || Date.now().toString(),
    });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ===============================
// START
// ===============================
app.listen(PORT, () => {
  console.log(`✅ Olympeus AI server running on port ${PORT}`);
});
