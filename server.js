import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const OPENAI_BASE_URL = "https://api.openai.com/v1";

// Sécurité
const OLYMPEUS_SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN || "";

// Helpers
function jsonError(res, status, code, message, detail) {
  return res.status(status).json({
    ok: false,
    status,
    error: code,
    message,
    detail,
  });
}

app.get("/", (req, res) => {
  res.status(200).send("Olympeus AI server OK");
});

/**
 * POST /post-assist
 * Headers: x-olympeus-token: <shared secret>
 * Body: { message: string, expert?: boolean, web?: boolean }
 */
app.post("/post-assist", async (req, res) => {
  try {
    // 1) Check token
    const token = req.headers["x-olympeus-token"];
    if (!OLYMPEUS_SHARED_TOKEN || token !== OLYMPEUS_SHARED_TOKEN) {
      return jsonError(res, 401, "unauthorized", "Bad or missing shared token");
    }

    // 2) Validate input
    const { message, expert = false, web = false } = req.body || {};
    if (typeof message !== "string" || message.trim().length < 1) {
      return jsonError(res, 400, "bad_request", "message is required");
    }

    // 3) Compose prompt
    const system = [
      "Tu es Olympeus-AI, assistant utile et concis.",
      expert ? "Mode expert: réponse structurée, technique si nécessaire." : "",
      web ? "Recherche web: si tu ne sais pas, dis-le (pas d'invention)." : "",
    ]
      .filter(Boolean)
      .join("\n");

    // 4) Call OpenAI (Responses API)
    const payload = {
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: [{ type: "text", text: system }] },
        { role: "user", content: [{ type: "text", text: message.trim() }] },
      ],
      // tu peux ajuster :
      max_output_tokens: 500,
    };

    const r = await fetch(`${OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();

    if (!r.ok) {
      return jsonError(res, r.status, "upstream_openai_error", "OpenAI error", data);
    }

    // 5) Extraire le texte (robuste)
    // Certaines réponses sont dans output_text, sinon on reconstruit depuis output[]
    const text =
      data.output_text ||
      (Array.isArray(data.output)
        ? data.output
            .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
            .filter((c) => c && c.type === "output_text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("\n")
        : "");

    return res.status(200).json({
      ok: true,
      status: 200,
      model: OPENAI_MODEL,
      text: text || "(vide)",
      raw_id: data.id,
    });
  } catch (e) {
    return jsonError(res, 500, "server_error", "Server crashed", String(e?.message || e));
  }
});

app.listen(PORT, () => {
  console.log(`Olympeus AI server running on port ${PORT}`);
});
