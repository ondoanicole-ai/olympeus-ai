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

    /* ---- 3. Simulation IA (à remplacer plus tard) ---- */
    const answer = `Réponse IA (demo) : ${message}`;

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
