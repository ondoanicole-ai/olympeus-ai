import express from "express";
import cors from "cors";

const app = express();

/* =========================
   CONFIG
========================= */

const PORT = process.env.PORT || 10000;
const SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN || "";

/* =========================
   MIDDLEWARES
========================= */

app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* =========================
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "olympeus-ai",
    status: "running"
  });
});

/* =========================
   POST /post-assist
========================= */

app.post("/post-assist", async (req, res) => {
  try {
    /* ---- 1. Vérif TOKEN ---- */
    const token =
      req.headers["x-olympeus-token"] ||
      req.headers["authorization"] ||
      "";

    if (!SHARED_TOKEN) {
      console.warn("⚠️ Aucun token configuré côté serveur");
    }

    if (SHARED_TOKEN && token !== SHARED_TOKEN) {
      console.warn("❌ Token invalide", { token });
      return res.status(401).json({
        ok: false,
        error: "unauthorized"
      });
    }

    /* ---- 2. Vérif payload ---- */
    const { message, conversationId, expert, web } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        ok: false,
        error: "missing_message"
      });
    }

  import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import Stripe from "stripe";
import pg from "pg";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;

const OLYMPEUS_SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_MAX_TOKENS = parseInt(process.env.OPENAI_MAX_TOKENS || "500", 10);

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- petit helper sécurité token (WP -> Render) ---
function requireSharedToken(req, res) {
  if (!OLYMPEUS_SHARED_TOKEN) return true; // si tu veux forcer, enlève cette ligne
  const token = req.header("x-olympeus-token");
  if (!token || token !== OLYMPEUS_SHARED_TOKEN) {
    res.status(401).json({ ok: false, error: "unauthorized_token" });
    return false;
  }
  return true;
}

app.get("/ping", (req, res) => res.status(200).send("Olympeus API OK"));

app.post("/post-assist", async (req, res) => {
  try {
    if (!requireSharedToken(req, res)) return;

    const { message, web, expert, conversationId, wpUserId, wpUserEmail } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "missing_message" });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "missing_openai_api_key" });
    }

    // prompt simple (tu pourras enrichir après)
    const system = `Tu es Olympeus AI. Réponds en français de façon claire et utile.`;
    const user = message.trim();

    const r = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: OPENAI_MAX_TOKENS,
      temperature: 0.7,
    });

    const answer = r.choices?.[0]?.message?.content?.trim() || "Réponse vide.";

    return res.json({
      ok: true,
      conversationId: conversationId || null,
      answer,
    });
  } catch (err) {
    console.error("post-assist error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

    /* ---- 4. Réponse ---- */
    return res.json({
      ok: true,
      answer,
      conversationId: conversationId || Date.now().toString()
    });

  } catch (err) {
    console.error("🔥 Erreur serveur :", err);
    return res.status(500).json({
      ok: false,
      error: "server_error"
    });
  }
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(`🚀 Olympeus AI server running on port ${PORT}`);
});
