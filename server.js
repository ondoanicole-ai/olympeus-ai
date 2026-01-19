import express from "express";

// Node 18+ a fetch global (Render a Node 22 dans tes logs)
const app = express();
app.use(express.json({ limit: "1mb" }));

/** =========================
 *  CONFIG
 *  ========================= */
const PORT = process.env.PORT || 10000;

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // change via env
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

// Security
const OLYMPEUS_SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://olympe-us.com";

// Rate limit (simple mémoire)
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 5);
const memoryDaily = new Map(); // key -> { count, dayKey }

/** =========================
 *  UTILS
 *  ========================= */
function todayKeyUTC() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "0.0.0.0";
}

function rateLimitOrThrow(limitKey) {
  const dayKey = todayKeyUTC();
  const current = memoryDaily.get(limitKey);

  if (!current || current.dayKey !== dayKey) {
    memoryDaily.set(limitKey, { count: 1, dayKey });
    return;
  }

  if (current.count >= FREE_DAILY_LIMIT) {
    const err = new Error("free_limit_reached");
    err.status = 429;
    throw err;
  }

  current.count += 1;
  memoryDaily.set(limitKey, current);
}

function assertSharedToken(req) {
  // token partagé WP -> Render
  if (!OLYMPEUS_SHARED_TOKEN) return; // si vide, pas de check (pas conseillé)
  const t = req.headers["x-olympeus-token"];
  if (!t || t !== OLYMPEUS_SHARED_TOKEN) {
    const err = new Error("unauthorized");
    err.status = 401;
    throw err;
  }
}

/** =========================
 *  CORS minimal (si besoin)
 *  ========================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Olympeus-Token");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/** =========================
 *  HEALTH
 *  ========================= */
app.get("/", (_req, res) => {
  res.status(200).send("ok");
});

/** =========================
 *  PROMPT
 *  ========================= */
function buildSystemPrompt({ expert, web }) {
  let p =
    "Tu es Olympeus AI, un assistant utile, clair et prudent. Réponds en français.";
  if (expert) {
    p +=
      " Mode expert: réponse plus structurée, précise, avec étapes et points clés quand c'est utile.";
  }
  if (web) {
    p +=
      " Mode web: si l'information manque, indique ce qu'il faudrait vérifier en ligne (sans inventer).";
  }
  return p;
}

/** =========================
 *  OPENAI CALL (non-stream)
 *  ========================= */
async function callOpenAI({ message, expert, web }) {
  if (!OPENAI_API_KEY) {
    const err = new Error("missing_openai_api_key");
    err.status = 500;
    throw err;
  }

  const system = buildSystemPrompt({ expert, web });

  const payload = {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: system },
      { role: "user", content: message },
    ],
  };

  const r = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const json = await r.json().catch(() => null);

  if (!r.ok) {
    const err = new Error("upstream_openai_error");
    err.status = 502;
    err.detail = json;
    throw err;
  }

  // Extraction texte (Responses API)
  // On prend output_text si présent sinon on tente un fallback.
  const text =
    json.output_text ||
    (Array.isArray(json.output) ? JSON.stringify(json.output) : "") ||
    "";

  return { text, raw: json };
}

/** =========================
 *  OPENAI STREAM (SSE)
 *  ========================= */
async function streamOpenAI({ message, expert, web, res }) {
  if (!OPENAI_API_KEY) {
    const err = new Error("missing_openai_api_key");
    err.status = 500;
    throw err;
  }

  const system = buildSystemPrompt({ expert, web });

  const payload = {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: system },
      { role: "user", content: message },
    ],
    stream: true,
  };

  const r = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok || !r.body) {
    const detail = await r.text().catch(() => "");
    const err = new Error("upstream_openai_error");
    err.status = 502;
    err.detail = detail;
    throw err;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const reader = r.body.getReader();
  const decoder = new TextDecoder("utf-8");

  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // OpenAI stream renvoie des lignes type "data: {...}\n"
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      // On forward tel quel au front sous forme "chunk"
      res.write(`event: chunk\ndata: ${data}\n\n`);
    }
  }

  res.write(`event: done\ndata: {}\n\n`);
  res.end();
}

/** =========================
 *  ROUTES
 *  ========================= */

// Non-stream (WordPress proxy)
app.post("/post-assist", async (req, res) => {
  try {
    assertSharedToken(req);

    const { message, expert = false, web = false, wpUserId = null } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "missing_message" });
    }

    const ip = getClientIp(req);
    const limitKey = wpUserId ? `wp:${wpUserId}` : `anon:${ip}`;
    rateLimitOrThrow(limitKey);

    const out = await callOpenAI({ message, expert, web });
    return res.status(200).json({
      ok: true,
      answer: out.text,
      model: OPENAI_MODEL,
    });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      ok: false,
      error: e.message || "server_error",
      detail: e.detail || null,
      model: OPENAI_MODEL,
    });
  }
});

// Stream (effet typing)
app.post("/post-assist-stream", async (req, res) => {
  try {
    assertSharedToken(req);

    const { message, expert = false, web = false, wpUserId = null } = req.body || {};
    if (!message || typeof message !== "string") {
      res.status(400).json({ ok: false, error: "missing_message" });
      return;
    }

    const ip = getClientIp(req);
    const limitKey = wpUserId ? `wp:${wpUserId}` : `anon:${ip}`;
    rateLimitOrThrow(limitKey);

    await streamOpenAI({ message, expert, web, res });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({
      ok: false,
      error: e.message || "server_error",
      detail: e.detail || null,
      model: OPENAI_MODEL,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Olympeus AI server running on port ${PORT}`);
  console.log(`Model = ${OPENAI_MODEL}`);
});
