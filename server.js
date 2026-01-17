import express from "express";
import cors from "cors";

const app = express();

// --- Middlewares
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// --- Config
const PORT = Number(process.env.PORT || 10000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const OLYMPEUS_SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN || "";

// --- Helpers
function requireBearerToken(expected) {
  return (req, res, next) => {
    if (!expected) return res.status(500).json({ ok: false, error: "Server token not configured" });

    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });
    next();
  };
}

// --- Routes
app.get("/", (req, res) => {
  res.status(200).send("Olympeus API OK");
});

app.get("/ping", (req, res) => {
  res.status(200).json({ ok: true, pong: true });
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, status: "healthy" });
});

// Endpoint appelé par WordPress (bridge)
app.post("/post-assist", requireBearerToken(OLYMPEUS_SHARED_TOKEN), async (req, res) => {
  try {
    const { message, expert, web } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "Missing message" });
    }

    // TODO: ici tu mets l’appel OpenAI / Tavily / DB etc.
    // Pour l’instant on répond juste pour valider toute la chaîne:
    const answer = `✅ Reçu: "${message}" | expert=${!!expert} | web=${!!web?.enabled}`;

    return res.status(200).json({
      ok: true,
      answer,
      conversationId: req.body?.conversationId || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Exemple route admin (optionnel)
app.get("/admin/ping", requireBearerToken(ADMIN_TOKEN), (req, res) => {
  res.status(200).json({ ok: true, admin: true });
});

// --- Start
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
