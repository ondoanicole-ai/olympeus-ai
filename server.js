import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-olympeus-token"],
  })
);

// ---- ENV (Render) ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OLYMPEUS_SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";

if (!OPENAI_API_KEY) console.warn("⚠ OPENAI_API_KEY manquant.");
if (!OLYMPEUS_SHARED_TOKEN) console.warn("⚠ OLYMPEUS_SHARED_TOKEN manquant.");

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---- Auth ----
function requireAuth(req, res, next) {
  const token = req.headers["x-olympeus-token"];
  if (!OLYMPEUS_SHARED_TOKEN || token !== OLYMPEUS_SHARED_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ---- Helpers ----
function clampMessages(history) {
  if (!Array.isArray(history)) return [];
  // on garde les 12 derniers messages max
  return history
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12);
}

async function tavilySearch(query) {
  if (!TAVILY_API_KEY) return { ok: false, error: "TAVILY_API_KEY manquant" };
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: "basic",
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    return { ok: false, error: `Tavily HTTP ${r.status}: ${txt}` };
  }
  const data = await r.json();
  const results = (data.results || []).map(x => ({
    title: x.title,
    url: x.url,
    snippet: x.content,
  }));
  return { ok: true, results };
}

async function moderate(text) {
  // Modération OpenAI (simple)
  const resp = await client.moderations.create({
    model: "omni-moderation-latest",
    input: text,
  });
  const r = resp.results?.[0];
  const flagged = !!r?.flagged;
  return { flagged, categories: r?.categories || {}, scores: r?.category_scores || {} };
}

// ---- Routes ----
app.get("/", (req, res) => res.send("OlympeUS AI API is running ✅"));
app.get("/health", (req, res) => res.send("OK"));

/**
 * POST /post-assist
 * body: {
 *  mode: "chat"|"ideas"|"improve"|"summary",
 *  draft?: string,
 *  theme?: string,
 *  history?: [{role:"user"|"assistant", content:string}],
 *  web?: { enabled?: boolean, query?: string }
 * }
 */
app.post("/post-assist", requireAuth, async (req, res) => {
  try {
    const mode = (req.body?.mode || "chat").toString();
    const draft = (req.body?.draft || "").toString();
    const theme = (req.body?.theme || "OlympeUS").toString();
    const history = clampMessages(req.body?.history);

    // 1) Modération (sur le texte envoyé)
    const mod = await moderate(draft);
    if (mod.flagged) {
      return res.status(400).json({
        error: "Contenu bloqué par la modération.",
        moderation: mod,
      });
    }

    // 2) Recherche web (optionnelle)
    let webContext = "";
    let webResults = [];
    const webEnabled = !!req.body?.web?.enabled;
    const webQuery = (req.body?.web?.query || "").toString().trim();

    if (webEnabled && webQuery) {
      const s = await tavilySearch(webQuery);
      if (s.ok) {
        webResults = s.results;
        // mini contexte injecté
        webContext =
          "Résultats web (sources) :\n" +
          webResults
            .map((r, i) => `(${i + 1}) ${r.title}\n${r.url}\n${r.snippet}`)
            .join("\n\n");
      } else {
        webContext = `Recherche web indisponible: ${s.error}`;
      }
    }

    // 3) Prompt selon mode
    const system =
      `Tu es l’assistant OlympeUS. Ton ton est chaleureux, neutre, respectueux, et tu tutoies.
Règles:
- Réponds en français.
- Sois concret, utile, pas de blabla.
- Si la recherche web est fournie, cite les sources avec (1)(2)(3) dans le texte.`;

    let userInstruction = "";
    if (mode === "ideas") {
      userInstruction =
        `Donne 5 idées de publication pour OlympeUS sur le thème: "${theme}". 
Format: liste numérotée. Chaque idée = un titre + 1 phrase de pitch.`;
    } else if (mode === "improve") {
      userInstruction =
        `Améliore ce texte sans changer le sens. Corrige l’orthographe, rends-le plus clair et engageant.
Donne 2 versions:
(A) courte
(B) plus engageante
Texte:\n${draft}`;
    } else if (mode === "summary") {
      userInstruction =
        `Fais une synthèse en 3 bullet points max, puis une phrase de conclusion.
Texte:\n${draft}`;
    } else {
      // chat
      userInstruction = `Réponds au dernier message de l’utilisateur de façon utile et naturelle.\nMessage:\n${draft}`;
    }

    const inputMessages = [
      { role: "system", content: system },
      ...(webContext ? [{ role: "system", content: webContext }] : []),
      ...history,
      { role: "user", content: userInstruction },
    ];

    // 4) Appel modèle
    const r = await client.responses.create({
      model: "gpt-4.1-mini",
      input: inputMessages,
    });

    const text = r.output_text || "";

    return res.json({
      text,
      web_results: webResults,
      moderation: { flagged: mod.flagged },
    });
  } catch (e) {
    console.error("post-assist error:", e);
    return res.status(500).json({ error: "post-assist failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Serveur lancé sur le port", port));
