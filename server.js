import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fetch from "node-fetch";

const app = express();

/* ------------------ CONFIG (ENV Render) ------------------ */
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OLYMPEUS_SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

/* ------------------ MIDDLEWARE ------------------ */
app.use(cors({ origin: "*", allowedHeaders: ["Content-Type", "x-olympeus-token"] }));
app.use(express.json({ limit: "1mb" }));

function requireAuth(req, res, next) {
  const token = req.headers["x-olympeus-token"];
  if (!token || token !== OLYMPEUS_SHARED_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/* ------------------ OPENAI CLIENT ------------------ */
if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY manquant dans Render");
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ------------------ HEALTH ------------------ */
app.get("/", (_, res) => {
  res.send("OlympeUS AI API is running ✅");
});

/* ------------------ TAVILY SEARCH ------------------ */
async function tavilySearch(query) {
  if (!TAVILY_API_KEY) return { ok: false, error: "Tavily API key missing" };

  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: "basic",
      max_results: 5
    })
  });

  const json = await r.json();
  if (!r.ok) return { ok: false, error: json?.error || "Tavily error" };

  return { ok: true, results: json.results || [] };
}

/* ------------------ CHAT / IDEAS / IMPROVE / SUMMARY ------------------ */
app.post("/post-assist", requireAuth, async (req, res) => {
  try {
    const { mode = "chat", draft = "", context = "" } = req.body;

    const systemPrompt =
      "Tu es OlympeUS, assistant francophone, chaleureux, neutre et respectueux (tu tutoies). " +
      "Réponds clairement et sans inventer des faits.";

    let userPrompt = draft;

    if (mode === "ideas") {
      userPrompt = `Donne 5 idées utiles et concrètes à partir du texte suivant:\n${draft}`;
    } else if (mode === "improve") {
      userPrompt = `Améliore le texte ci-dessous avec 2 versions (A et B). Garde le sens:\n${draft}`;
    } else if (mode === "summary") {
      userPrompt = `Fais un résumé clair (2-3 phrases max) du texte suivant:\n${draft}`;
    } else {
      // mode chat
      userPrompt = draft;
    }

    if (context) {
      userPrompt = `Voici des sources/contexte:\n${context}\n\nMessage utilisateur:\n${userPrompt}`;
    }

    const r = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    res.json({ text: r.output_text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "post-assist failed" });
  }
});

/* ------------------ WEB SEARCH ENDPOINT ------------------ */
app.post("/web-search", requireAuth, async (req, res) => {
  try {
    const q = (req.body.query || "").trim();
    if (!q) return res.status(400).json({ error: "Query missing" });

    const s = await tavilySearch(q);
    if (!s.ok) return res.status(500).json({ error: s.error });

    res.json({ results: s.results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "web-search failed" });
  }
});

/* ------------------ START ------------------ */
app.listen(PORT, () => console.log("Server running on port", PORT));

