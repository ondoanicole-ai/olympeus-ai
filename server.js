import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
function requireAuth(req, res, next) {
  const token = req.headers["x-olympeus-token"];
  if (!process.env.OLYMPEUS_SHARED_TOKEN || token !== process.env.OLYMPEUS_SHARED_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/profile-assist", requireAuth, async (req, res) => {
  try {
    const { role, goals, interests, location, avoid } = req.body;

    const r = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: "Tu es l’assistant officiel d’OlympeUS. Ton ton est chaleureux, neutre, et tu tutoies." },
        { role: "user", content: `Rôle: ${role}\nObjectifs: ${goals}\nCentres d’intérêt: ${interests}\nVille: ${location}\nÀ éviter: ${avoid}\nGénère une bio de 100 mots.` }
      ]
    });

    res.json({ text: r.output_text });
  } catch (err) {
    res.status(500).json({ error: "Erreur IA" });
  }
});


app.get("/health", (req, res) => res.send("OK"));
app.get("/", (req, res) => res.send("OlympeUS AI API is running ✅"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Serveur lancé sur le port", port));
app.post("/profile-assist", requireAuth, async (req, res) => {
  try {
    const { role, goals, interests, location, avoid, mode, draft } = req.body;

    const system =
      "Tu es l’assistant officiel d’écriture d’OlympeUS. Ton ton est chaleureux, neutre, positif. Tu tutoies. Tu n’inventes pas de faits.";

    const user =
      mode === "improve"
        ? `Réécris cette bio pour qu’elle soit plus claire et agréable, sans changer le sens. Bio:\n${draft || ""}`
        : `Génère pour OlympeUS : (1) une accroche 1 ligne, (2) une bio 80–120 mots, (3) 10 tags, (4) 3 espaces recommandés parmi: Emploi, Entrepreneuriat, Société & débats, Création, Rencontres & soutien.
Infos:
- Rôle/activité: ${role || ""}
- Objectifs: ${goals || ""}
- Centres d’intérêt: ${interests || ""}
- Ville/pays: ${location || ""}
- À éviter: ${avoid || ""}`;

    const r = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    res.json({ text: r.output_text });
  } catch (e) {
    res.status(500).json({ error: "profile-assist failed" });
  }
});
app.post("/post-assist", requireAuth, async (req, res) => {
  try {
    const { mode, theme, draft } = req.body;

    const system =
      "Tu es l’assistant de contenu d’OlympeUS. Ton ton est chaleureux, neutre, respectueux. Tu tutoies.";

    let user = "";
    if (mode === "ideas") {
      user = `Donne 5 idées de publication pour OlympeUS sur le thème: ${theme || "Création"}.
Format: liste numérotée, chaque idée = un titre + 1 phrase de pitch.`;
    } else if (mode === "improve") {
      user = `Réécris ce post pour qu’il soit plus clair, plus agréable à lire et respectueux, sans changer le sens:\n${draft || ""}`;
    } else if (mode === "summary") {
      user = `Résume ce post en 3 lignes maximum + propose un titre court (max 7 mots):\n${draft || ""}`;
    } else {
      return res.status(400).json({ error: "unknown mode" });
    }

    const r = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    res.json({ text: r.output_text });
  } catch (e) {
    res.status(500).json({ error: "post-assist failed" });
  }
});




