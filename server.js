import express from "express";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "1mb" }));

/** =========================
 * CONFIG
 * ========================= */
const PORT = Number(process.env.PORT || 10000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

const OLYMPEUS_SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://olympe-us.com";

// Rate limit (mémoire simple)
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 20);
const memoryDaily = new Map(); // key -> { count, dayKey }

/** =========================
 * CORS (utile si tu testes en direct)
 * ========================= */
app.use(
  cors({
    origin: (origin, cb) => {
      // autorise appels serveur->serveur (pas d'origin) + ton domaine
      if (!origin || origin === ALLOWED_ORIGIN) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Olympeus-Token"],
  })
);

app.options("*", (req, res) => res.sendStatus(204));

/** =========================
 * UTILS
 * ========================= */
function todayKeyUTC() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function checkSharedToken(req) {
  if (!OLYMPEUS_SHARED_TOKEN) return true; // si pas défini, on n'active pas la protection
  const token = req.headers["x-olympeus-token"];
  return token && token === OLYMPEUS_SHARED_TOKEN;
}

function rateLimitKey(req, body) {
  // Priorité : wpUserId si fourni, sinon IP
  if (body?.wpUserId) return `user:${String(body.wpUserId)}`;
  return `ip:${getClientIp(req)}`;
}

function bumpDailyLimit(key) {
  const dayKey = todayKeyUTC();
  const cur = memoryDaily.get(key);
  if (!cur || cur.dayKey !== dayKey) {
    memoryDaily.set(key, { count: 1, dayKey });
    return { ok: true, count: 1, limit: FREE_DAILY_LIMIT };
  }
  if (cur.count >= FREE_DAILY_LIMIT) {
    return { ok: false, count: cur.count, limit: FREE_DAILY_LIMIT };
  }
  cur.count += 1;
  memoryDaily.set(key, cur);
  return { ok: true, count: cur.count, limit: FREE_DAILY_LIMIT };
}

function buildPrompt({ message, expert, web }) {
  const mode = expert ? "MODE EXPERT" : "MODE SIMPLE";
  const webHint = web ? "Tu peux proposer des requêtes de recherche web, mais ne mens pas." : "Pas de web.";
  return [
    `Tu es Olympeus AI.`,
    `Réponds en français.`,
    `Mode: ${mode}.`,
    webHint,
    ``,
    `Question utilisateur:`,
    message,
  ].join("\n");
}

function extractOutputText(openaiJson) {
  // Réponses API: souvent output_text est présent
  if (typeof openaiJson?.output_text === "string") return openaiJson.output_text;

  // Sinon, essayer output[] -> content[]
  const out = openaiJson?.output;
  if (Array.isArray(out)) {
    let text = "";
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === "string") text += c.text;
          if (typeof c?.content === "string") text += c.content;
        }
      }
    }
    if (text.trim()) return text.trim();
  }
  return "";
}

/** =========================
 * HEALTH
 * ========================= */
app.get("/", (req, res) => {
  res.json({ ok: true, name: "olympeus-ai", status: "alive" });
});

/** =========================
 * MAIN ENDPOINT (WordPress proxy -> Render)
 * ========================= */
app.post("/post-assist", async (req, res) => {
  try {
    // 1) Token
    if (!checkSharedToken(req)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // 2) Body
    const { message, expert = false, web = false, wpUserId = null } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ ok: false, error: "missing_message" });
    }

    // 3) Rate limit
    const key = rateLimitKey(req, { wpUserId });
    const rl = bumpDailyLimit(key);
    if (!rl.ok) {
      return res.status(429).json({
        ok: false,
        error: "rate_limited",
        detail: { limit: rl.limit, count: rl.count },
      });
    }

    // 4) OpenAI config check
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "missing_openai_key" });
    }

    // 5) Prompt
    const prompt = buildPrompt({ message: message.trim(), expert: !!expert, web: !!web });

    // 6) Call OpenAI Responses API (FORMAT CORRECT)
    const payload = {
      model: OPENAI_MODEL,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      temperature: expert ? 0.2 : 0.5,
      max_output_tokens: expert ? 800 : 500,
    };

    const resp = await fetch(`${OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return res.status(502).json({ ok: false, error: "openai_non_json", raw: text.slice(0, 500) });
    }

    if (!resp.ok) {
      // renvoyer l'erreur OpenAI telle quelle pour debug côté WP (mais sans exposer la clé)
      return res.status(502).json({
        ok: false,
        error: "upstream_openai_error",
        detail: json,
      });
    }

    const answer = extractOutputText(json);
    if (!answer) {
      return res.status(502).json({
        ok: false,
        error: "empty_openai_answer",
        detail: json,
      });
    }

    return res.json({
      ok: true,
      answer,
      model: OPENAI_MODEL,
      usage: json?.usage || null,
      rate: { count: rl.count, limit: rl.limit },
    });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.listen(PORT, () => {
  console.log(`Olympeus AI server running on port ${PORT}`);
});
