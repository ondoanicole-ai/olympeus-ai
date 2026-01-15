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

// ===== ENV (Render) =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OLYMPEUS_SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN;

// (Optionnel) Recherche web via Serper.dev (Google)
// Crée une clé sur serper.dev puis mets SERPER_API_KEY dans Render.
const SERPER_API_KEY = process.env.SERPER_API_KEY;

// Modèle demandé
const MODEL = "gpt-4.1-mini";

if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY manquant.");
if (!OLYMPEUS_SHARED_TOKEN) console.warn("⚠️ OLYMPEUS_SHARED_TOKEN manquant.");

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===== Auth middleware =====
function requireAuth(req, res, next) {
  const token = req.headers["x-olympeus-token"];
  if (!OLYMPEUS_SHARED_TOKEN || token !== OLYMPEUS_SHARED_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ===== Helpers =====
function safeStr(x, max = 6000) {
  return (x ?? "").toString().trim().slice(0, max);
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-20)
    .map((m) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: safeStr(m?.content, 2000),
    }))
    .filter((m) => m.content.length > 0);
}

function isBlockedBySoftModeration(text) {
  const t = (text || "").toLowerCase();
  const blocked = [
    "tuer",
    "suicide",
    "me suicider",
    "bombe",
    "explosif",
    "arme",
    "porn",
    "pédophile",
  ];
  return blocked.some((w) => t.includes(w));
}

async function webSearchSerper(query) {
  if (!SERPER_API_KEY) return [];
  const q = safeStr(query, 200);

  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q, num: 5 }),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Serper error ${r.status}: ${txt.slice(0, 120)}`);
  }

  const data = await r.json();
  const items = Array.isArray(data?.organic) ? data.organic : [];
  return items.slice(0, 5).map((it) => ({
    title: safeStr(it?.title, 140),
    link: safeStr(it?.link, 400),
    snippet: safeStr(it?.snippet, 280),
  }));
}

function buildSystemPrompt() {
  return `
Tu es l’assistant de contenu d’OlympeUS.
Ton ton est chaleureux, neutre, respectueux. Tu tutoies.
Tu aides à: idées de posts, amélioration, résumé, conversation multi-tours.
Si des "sources web" sont fournies, utilise-les pour répondre et cite les liens (1–3 max).
Ne divulgue jamais de clés, tokens ou secrets.
`.trim();
}

function buildTaskPrompt(mode, draft, theme) {
  const th = safeStr(theme || "OlympeUS", 60);

  if (mode === "ideas") {
    return `
Objectif: proposer 6 idées de publications utiles pour l'utilisateur.
Contexte: OlympeUS / thème: ${th}
Texte utilisateur (si présent): ${safeStr(draft, 1200)}
Format: liste numérotée. Pour chaque idée: Titre + 1 phrase de pitch + 1 call-to-action.
`.trim();
  }

  if (mode === "improve") {
    return `
Réécris le texte ci-dessous en 2 versions:
(A) courte, claire (orthographe + style)
(B) plus engageante, sans changer le sens
Texte: ${safeStr(draft, 1600)}
`.trim();
  }

  if (mode === "resume") {
    return `
Résume le texte ci-dessous en 3–5 puces, puis donne une phrase de conclusion.
Texte: ${safeStr(draft, 1600)}
`.trim();
  }

  // chat
  return `
Tu réponds à l’utilisateur en conversation multi-tours, de façon utile et concrète.
Dernier message utilisateur: ${safeStr(draft, 1600)}
`.trim();
}

function formatContext(siteContext = [], webResults = []) {
  const site = Array.isArray(siteContext) ? siteContext.slice(0, 6) : [];
  const web = Array.isArray(webResults) ? webResults.slice(0, 5) : [];

  let out = "";
  if (site.length) {
    out += "CONTEXTE SITE (titres/liens):\n";
    out += site
      .map((s, i) => `- ${i + 1}. ${safeStr(s?.title, 120)} — ${safeStr(s?.url, 300)}`)
      .join("\n");
    out += "\n\n";
  }

  if (web.length) {
    out += "SOURCES WEB:\n";
    out += web
      .map(
        (w, i) =>
          `- ${i + 1}. ${safeStr(w?.title, 140)}\n  ${safeStr(w?.snippet, 260)}\n  ${safeStr(w?.link, 350)}`
      )
      .join("\n");
    out += "\n\n";
  }

  return out.trim();
}

// ===== Routes =====
app.get("/health", (req, res) => res.send("OK"));
app.get("/", (req, res) => res.send("OlympeUS AI API is running ✅"));

app.post("/post-assist", requireAuth, async (req, res) => {
  try {
    const {
      mode = "chat",
      draft = "",
      theme = "OlympeUS",
      messages = [],
      siteContext = [],
      moderation = true,
      webSearch = false,
      webQuery = "",
    } = req.body || {};

    const draftSafe = safeStr(draft, 6000);

    // Soft moderation (option)
    if (moderation && isBlockedBySoftModeration(draftSafe)) {
      return res.status(400).json({
        error: "Contenu bloqué par la modération (soft). Reformule ton texte.",
      });
    }

    // Web search (option)
    let webResults = [];
    if (webSearch && safeStr(webQuery, 200)) {
      try {
        webResults = await webSearchSerper(webQuery);
      } catch (e) {
        // On n’échoue pas toute la requête si la recherche web a un souci
        console.warn("Web search failed:", e.message);
      }
    }

    const sys = buildSystemPrompt();
    const task = buildTaskPrompt(mode, draftSafe, theme);
    const convo = sanitizeMessages(messages);

    // Contexte (site + web)
    const ctx = formatContext(siteContext, webResults);

    const inputMessages = [
      { role: "system", content: sys },
      ...(ctx ? [{ role: "system", content: ctx }] : []),
    ];

    // Pour le mode chat, on injecte l’historique, sinon on fait simple
    if (mode === "chat" && convo.length) {
      inputMessages.push(...convo);
      // Si le dernier message n'est pas déjà celui du draft, on l'ajoute
      if (draftSafe && convo[convo.length - 1]?.content !== draftSafe) {
        inputMessages.push({ role: "user", content: draftSafe });
      }
    } else {
      inputMessages.push({ role: "user", content: task });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY manquant côté Render." });
    }

    const r = await client.responses.create({
      model: MODEL,
      input: inputMessages,
    });

    const text = r.output_text || "";

    return res.json({
      text,
      web_results: webResults,
    });
  } catch (e) {
    console.error("post-assist error:", e);
    return res.status(500).json({ error: "post-assist failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Serveur lancé sur le port", port));
