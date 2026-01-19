import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

/** ======================
 *  CONFIG
 *  ====================== */
const PORT = process.env.PORT || 10000;

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini"; // ou "gpt-4.1"
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

// Security: token partagé WP -> Render
const OLYMPEUS_SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN;

// CORS (si tu veux le limiter)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://olympe-us.com";

/** ======================
 *  UTILS
 *  ====================== */
function jsonError(res, status, code, extra = {}) {
  return res.status(status).json({ ok: false, error: code, ...extra });
}

function requireSharedToken(req, res) {
  if (!OLYMPEUS_SHARED_TOKEN) {
    return jsonError(res, 500, "missing_shared_token_env");
  }
  const token = req.headers["x-olympeus-token"];
  if (!token || token !== OLYMPEUS_SHARED_TOKEN) {
    return jsonError(res, 401, "unauthorized");
  }
  return null;
}

function buildSystemPrompt({ expert }) {
  const base =
    "Tu es Olympeus AI, assistant utile, clair, et fiable. Réponds en français.";
  if (expert) {
    return (
      base +
      " Mode EXPERT: réponse structurée (titres, étapes), précise, avec nuances. " +
      "Si la question touche au droit: cite les notions générales, et propose des vérifications, sans inventer."
    );
  }
  return base + " Mode STANDARD: réponse courte, simple et actionnable.";
}

function buildUserPrompt({ message, web }) {
  const webHint = web ? " (Tu peux proposer des pistes de recherche web, sans inventer de sources.)" : "";
  return `${message}${webHint}`;
}

async function callOpenAIResponse({ message, expert, web, userLabel }) {
  if (!OPENAI_API_KEY) {
    return { ok: false, status: 500, error: "missing_openai_api_key" };
  }

  const payload = {
    model: OPENAI_MODEL,
    input: [
      {
        role: "system",
        content: [{ type: "text", text: buildSystemPrompt({ expert }) }],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildUserPrompt({ message, web }),
          },
        ],
      },
    ],
    // Petit plus: on “tag” l’utilisateur côté backend (utile logs)
    metadata: { user: userLabel || "unknown" },
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
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // parfois OpenAI renvoie un message non JSON si proxy/WAF
  }

  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      error: "upstream_openai_error",
      detail: json || { raw: text },
    };
  }

  // Récupération du texte final (Responses API)
  const answer =
    (json.output_text && String(json.output_text)) ||
    // fallback si output_text absent
    "";

  return { ok: true, answer, raw: json };
}

/** ======================
 *  ROUTES
 *  ====================== */

app.get("/", (req, res) => res.status(200).send("OK"));

// Non-streaming
app.post("/post-assist", async (req, res) => {
  const err = requireSharedToken(req, res);
  if (err) return;

  const { message, expert = false, web = false, wpUser = "guest" } = req.body || {};
  if (!message || typeof message !== "string") {
    return jsonError(res, 400, "missing_message");
  }

  try {
    const out = await callOpenAIResponse({
      message,
      expert: !!expert,
      web: !!web,
      userLabel: wpUser,
    });

    if (!out.ok) {
      return res.status(502).json(out);
    }

    return res.json({
      ok: true,
      answer: out.answer,
      conversationId: Date.now().toString(),
      model: OPENAI_MODEL,
    });
  } catch (e) {
    return jsonError(res, 500, "server_error", { detail: String(e?.message || e) });
  }
});

// Streaming SSE (simple)
app.post("/post-assist/stream", async (req, res) => {
  const err = requireSharedToken(req, res);
  if (err) return;

  const { message, expert = false, web = false, wpUser = "guest" } = req.body || {};
  if (!message || typeof message !== "string") {
    return jsonError(res, 400, "missing_message");
  }
  if (!OPENAI_API_KEY) return jsonError(res, 500, "missing_openai_api_key");

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // Helper SSE
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const payload = {
      model: OPENAI_MODEL,
      stream: true,
      input: [
        {
          role: "system",
          content: [{ type: "text", text: buildSystemPrompt({ expert: !!expert }) }],
        },
        {
          role: "user",
          content: [{ type: "text", text: buildUserPrompt({ message, web: !!web }) }],
        },
      ],
      metadata: { user: wpUser || "unknown" },
    };

    const upstream = await fetch(`${OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok || !upstream.body) {
      const t = await upstream.text();
      send("error", {
        ok: false,
        error: "upstream_openai_error",
        status: upstream.status,
        detail: t,
      });
      return res.end();
    }

    send("meta", { ok: true, model: OPENAI_MODEL });

    // On relaie le flux tel quel (SSE OpenAI -> SSE client)
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // OpenAI renvoie des lignes SSE "data: ..."
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          send("done", { ok: true });
          res.end();
          return;
        }
        // On renvoie la ligne brute au client
        send("chunk", { raw: data });
      }
    }

    send("done", { ok: true });
    res.end();
  } catch (e) {
    send("error", { ok: false, error: "server_error", detail: String(e?.message || e) });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`✅ Olympeus AI server running on port ${PORT}`);
});
