import express from "express";
import cors from "cors";

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 10000;

// Token partagé WP -> Render (obligatoire)
const SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN || "";

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // ⚠️ lettre "o", pas zéro

// Sécurité basique
const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 2000);

// CORS (pas crucial si WP proxy, mais ok)
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

app.use(express.json({ limit: "1mb" }));

// Health
app.get("/", (req, res) => {
  res.status(200).send("Olympeus API OK ✅");
});

// -------- Helpers --------
function safeString(x) {
  if (typeof x !== "string") return "";
  return x;
}

function requireToken(req) {
  if (!SHARED_TOKEN) return true; // si tu as oublié de le mettre, on ne bloque pas en dev
  const got = req.get("x-olympeus-token") || "";
  return got === SHARED_TOKEN;
}

function buildMessages({ message, expert, web }) {
  const systemBase =
    "Tu es Olympeus AI, un assistant utile, clair et fiable. Réponds en français.";
  const systemExpert =
    "Mode expert: structure ta réponse, sois précis, donne des étapes, des exemples, et signale les limites/risques.";
  const systemNormal =
    "Mode normal: réponse courte, simple, pratique, sans jargon.";

  const system = [
    systemBase,
    expert ? systemExpert : systemNormal,
    web?.enabled
      ? "L'utilisateur a activé 'Recherche web'. Si tu ne peux pas réellement naviguer, reste prudent et ne fabrique pas de sources."
      : "La recherche web est désactivée. Ne prétends pas utiliser Internet.",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: message },
  ];
}

async function callOpenAIChat({ message, expert, web }) {
  if (!OPENAI_API_KEY) {
    return {
      ok: false,
      status: 500,
      error: "missing_openai_key",
      detail: "OPENAI_API_KEY manquante sur Render.",
    };
  }

  const messages = buildMessages({ message, expert, web });

  // API Chat Completions (stable)
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: expert ? 0.4 : 0.6,
    }),
  });

  const data = await resp.json().catch(() => null);

  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      error: "upstream_openai_error",
      detail: data || { message: "OpenAI error (no json)" },
    };
  }

  const answer =
    data?.choices?.[0]?.message?.content?.trim?.() ||
    "Réponse vide (OpenAI).";

  return {
    ok: true,
    status: 200,
    answer,
    usage: data?.usage || null,
  };
}

// ---------- Main endpoint ----------
app.post("/post-assist", async (req, res) => {
  try {
    // 1) Sécurité token (WP -> Render)
    if (!requireToken(req)) {
      return res.status(401).json({ ok: false, error: "invalid_token" });
    }

    // 2) Validation payload
    const body = req.body || {};
    const message = safeString(body.message).trim();
    const expert = !!body.expert;
    const web = body.web && typeof body.web === "object" ? body.web : { enabled: false };

    if (!message) {
      return res.status(400).json({ ok: false, error: "missing_message" });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(413).json({
        ok: false,
        error: "message_too_long",
        limit: MAX_MESSAGE_CHARS,
      });
    }

    // 3) Appel IA
    const out = await callOpenAIChat({ message, expert, web });

    if (!out.ok) {
      return res.status(out.status || 502).json({
        ok: false,
        error: out.error,
        detail: out.detail,
      });
    }

    return res.status(200).json({
      ok: true,
      answer: out.answer,
      // conversationId simple
      conversationId: body.conversationId || Date.now().toString(),
      usage: out.usage,
    });
  } catch (err) {
    console.error("🔥 Erreur serveur :", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Start
app.listen(PORT, () => {
  console.log(`🚀 Olympeus AI server running on port ${PORT}`);
});
