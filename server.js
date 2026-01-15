import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS (simple et permissif). Si tu veux restreindre à ton domaine plus tard, on le fera.
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-olympeus-token"],
  })
);

// --- ENV (Render) ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // <-- clé OpenAI
const OLYMPEUS_SHARED_TOKEN = process.env.OLYMPEUS_SHARED_TOKEN; // <-- ton token partagé

if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY manquant.");
if (!OLYMPEUS_SHARED_TOKEN) console.warn("⚠️ OLYMPEUS_SHARED_TOKEN manquant.");

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Auth middleware (token partagé) ---
function requireAuth(req, res, next) {
  const token = req.headers["x-olympeus-token"];
  if (!OLYMPEUS_SHARED_TOKEN || !token || token !== OLYMPEUS_SHARED_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// --- Mémoire conversation (en RAM) ---
// ⚠️ Sur Render free, ça peut redémarrer => mémoire remise à zéro. Plus tard on pourra stocker en DB.
const conversations = new Map(); // conversationId -> [{role, content}, ...]

function getHistory(conversationId) {
  if (!conversationId) return [];
  if (!conversations.has(conversationId)) conversations.set(conversationId, []);
  return conversations.get(conversationId);
}

function pushHistory(conversationId, role, content) {
  if (!conversationId) return;
  const hist = getHistory(conversationId);
  hist.push({ role, content });

  // garde max 20 messages pour éviter de gonfler
  if (hist.length > 20) hist.splice(0, hist.length - 20);
}

// --- Mini base de "recherche" (tu peux la remplir) ---
const KB = [
  {
    id: "olympeus-vision",
    title: "Vision OlympeUS",
    text: "OlympeUS est un paradis social centré sur les utilisateurs: se divertir, créer, s'entraider, réseauter, publier, partager et monétiser via e-commerce.",
    tags: ["vision", "social", "communauté"],
  },
  {
    id: "olympeus-espaces",
    title: "Espaces clés",
    text: "Espaces recommandés: Emploi, Entrepreneuriat, Société, Politique, Religion, Culture, Business, Création.",
    tags: ["espaces", "thématiques"],
  },
];

// Utilitaire: recherche simple dans KB
function simpleSearch(query) {
  const q = (query || "").toLowerCase().trim();
  if (!q) return [];
  return KB.filter(
    (doc) =>
      doc.title.toLowerCase().includes(q) ||
      doc.text.toLowerCase().includes(q) ||
      doc.tags.some((t) => t.toLowerCase().includes(q))
  ).slice(0, 5);
}

// --- Prompts (ton chaleureux, neutre, tutoie) ---
const SYSTEM_BASE = `
Tu es l'assistant officiel d'OlympeUS.
Ton ton est chaleureux, neutre, respectueux. Tu tutoies.
Tu aides à créer du contenu, à structurer des idées, à rédiger des posts, et à proposer des espaces (thématiques) pertinents.
Réponds en français.
`;

// ============== ROUTES ==============

// Health + home
app.get("/health", (req, res) => res.send("OK"));
app.get("/", (req, res) => res.send("OlympeUS AI API is running ✅"));

// 1) Profil: bio + accroche + tags + espaces recommandés (incluant Religion)
app.post("/profile-assist", requireAuth, async (req, res) => {
  try {
    const { mode, role, goals, interests, location, avoid, draft } = req.body || {};

    const userPrompt =
      mode === "improve"
        ? `Améliore cette bio sans changer le fond. Bio:\n${draft || ""}\n\nContraintes:
- 1 accroche (1 ligne)
- 1 bio (80-120 mots)
- 10 tags
- 5 espaces recommandés parmi: Emploi, Entrepreneuriat, Société, Politique, Religion, Culture, Business, Création
- Style: clair, chaleureux, neutre, tutoiement`
        : `Génère un profil OlympeUS.
Infos:
- Rôle/activité: ${role || ""}
- Objectifs: ${goals || ""}
- Centres d'intérêt: ${interests || ""}
- Ville/pays: ${location || ""}
- À éviter: ${avoid || ""}

Format de sortie EXACT:
1) Accroche:
2) Bio:
3) Tags:
4) Espaces recommandés:`;

    const r = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: SYSTEM_BASE },
        { role: "user", content: userPrompt },
      ],
    });

    res.json({ text: r.output_text });
  } catch (e) {
    console.error("profile-assist error:", e?.message || e);
    res.status(500).json({ error: "profile-assist failed" });
  }
});

// 2) Post: idées / amélioration / résumé / génération libre
app.post("/post-assist", requireAuth, async (req, res) => {
  try {
    const { mode, theme, draft } = req.body || {};

    let userPrompt = "";
    if (mode === "ideas") {
      userPrompt = `Donne 7 idées de publication OlympeUS sur le thème: ${theme || "Création"}.
Format: liste numérotée, chaque idée = (Titre) + (1 phrase de pitch) + (1 call-to-action).`;
    } else if (mode === "improve") {
      userPrompt = `Réécris ce post pour qu'il soit plus clair, plus agréable et respectueux, sans changer le sens.
Post:\n${draft || ""}\n\nDonne 2 versions: (A) courte (B) plus engageante.`;
    } else if (mode === "summary") {
      userPrompt = `Résume ce texte en 5 points + une phrase finale.
Texte:\n${draft || ""}`;
    } else {
      userPrompt = `Génère un texte original OlympeUS sur: ${theme || "OlympeUS"}.
Contraintes: 150-220 mots, ton chaleureux et neutre, tutoiement, termine par une question.`;
    }

    const r = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: SYSTEM_BASE },
        { role: "user", content: userPrompt },
      ],
    });

    res.json({ text: r.output_text });
  } catch (e) {
    console.error("post-assist error:", e?.message || e);
    res.status(500).json({ error: "post-assist failed" });
  }
});

// 3) Conversation (chat) avec mémoire (conversationId)
app.post("/chat", requireAuth, async (req, res) => {
  try {
    const { conversationId, message } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "message missing" });
    }

    const history = getHistory(conversationId);

    // Ajoute le message user à l'historique
    pushHistory(conversationId, "user", String(message));

    const input = [
      { role: "system", content: SYSTEM_BASE },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: String(message) },
    ];

    const r = await client.responses.create({
      model: "gpt-5-mini",
      input,
    });

    const answer = r.output_text || "";
    pushHistory(conversationId, "assistant", answer);

    res.json({ text: answer, conversationId: conversationId || null });
  } catch (e) {
    console.error("chat error:", e?.message || e);
    res.status(500).json({ error: "chat failed" });
  }
});

// 4) Recherche (simple): renvoie des résultats KB + option “réponse IA”
app.post("/search", requireAuth, async (req, res) => {
  try {
    const { query, aiAnswer } = req.body || {};
    const results = simpleSearch(query);

    if (!aiAnswer) {
      return res.json({ results });
    }

    const context = results.map((r) => `- ${r.title}: ${r.text}`).join("\n");
    const prompt = `Question: ${query || ""}

Contexte (si utile):
${context || "(aucun résultat)"}

Réponds clairement en 6-10 lignes max.`;

    const r = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: SYSTEM_BASE },
        { role: "user", content: prompt },
      ],
    });

    res.json({ results, answer: r.output_text });
  } catch (e) {
    console.error("search error:", e?.message || e);
    res.status(500).json({ error: "search failed" });
  }
});

// 5) Génération libre (texte long, article, page À propos, etc.)
app.post("/generate", requireAuth, async (req, res) => {
  try {
    const { instruction } = req.body || {};
    if (!instruction || !String(instruction).trim()) {
      return res.status(400).json({ error: "instruction missing" });
    }

    const r = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: SYSTEM_BASE },
        { role: "user", content: String(instruction) },
      ],
    });

    res.json({ text: r.output_text });
  } catch (e) {
    console.error("generate error:", e?.message || e);
    res.status(500).json({ error: "generate failed" });
  }
});

// --- Start ---
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Serveur lancé sur le port", port));
app.get("/test-ai", async (req, res) => {
  try {
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: "Dis simplement : L’IA fonctionne correctement."
    });

    res.json({
      ok: true,
      result: response.output_text
    });
  } catch (error) {
    console.error("TEST AI ERROR:", error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

