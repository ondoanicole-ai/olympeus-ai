import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function requireAuth(req, res, next) {
  const token = req.headers["x-olympeus-token"];
  if (!process.env.OLYMPEUS_SHARED_TOKEN || token !== process.env.OLYMPEUS_SHARED_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

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


