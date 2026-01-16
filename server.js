import express from "express";
import cors from "cors";
import OpenAI from "openai";
import pkg from "pg";
import fetch from "node-fetch";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

/* ENV */
const {
  OPENAI_API_KEY,
  OLYMPEUS_SHARED_TOKEN,
  TAVILY_API_KEY,
  DATABASE_URL
} = process.env;

/* DB */
const pool = new Pool({ connectionString: DATABASE_URL });

/* OpenAI */
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* Auth middleware */
function auth(req, res, next) {
  if (req.headers["x-olympeus-token"] !== OLYMPEUS_SHARED_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/* POST /post-assist */
app.post("/post-assist", auth, async (req, res) => {
  const { wp_user_id, message, use_web } = req.body;

  /* User */
  const userResult = await pool.query(
    `INSERT INTO users (wp_user_id)
     VALUES ($1)
     ON CONFLICT (wp_user_id) DO UPDATE SET wp_user_id = EXCLUDED.wp_user_id
     RETURNING *`,
    [wp_user_id]
  );
  const user = userResult.rows[0];

  /* Quota */
  const quota = user.role === "free" ? 30 : 300;
  const usage = await pool.query(
    `SELECT COALESCE(SUM(tokens),0) as used
     FROM usage WHERE user_id=$1 AND created_at=CURRENT_DATE`,
    [user.id]
  );
  if (usage.rows[0].used >= quota) {
    return res.json({ text: "Quota journalier atteint." });
  }

  /* Conversation */
  const conv = await pool.query(
    `INSERT INTO conversations (user_id) VALUES ($1) RETURNING *`,
    [user.id]
  );

  /* Mémoire courte */
  const history = await pool.query(
    `SELECT role, content FROM messages
     WHERE conversation_id=$1
     ORDER BY created_at DESC LIMIT 6`,
    [conv.rows[0].id]
  );

  let systemPrompt = `
Tu es OlympeUS, assistant fiable, neutre, pédagogique.
Ne devine jamais un fait.
Si une info manque, dis-le clairement.
`;

  /* Tavily (OPTIONNEL) */
  if (use_web === true && TAVILY_API_KEY) {
    const web = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: message,
        max_results: 3
      })
    }).then(r => r.json());

    const context = web.results
      .map(r => `Source fiable:\n${r.content}`)
      .join("\n\n");

    systemPrompt += `\nCONTEXTE EXTERNE:\n${context}\n`;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.rows.reverse(),
    { role: "user", content: message }
  ];

  /* OpenAI */
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages,
    temperature: 0.3
  });

  const reply = completion.choices[0].message.content;
  const tokens = completion.usage.total_tokens;

  /* Save memory */
  await pool.query(
    `INSERT INTO messages (conversation_id, role, content)
     VALUES ($1,'user',$2),($1,'assistant',$3)`,
    [conv.rows[0].id, message, reply]
  );

  await pool.query(
    `INSERT INTO usage (user_id, tokens) VALUES ($1,$2)`,
    [user.id, tokens]
  );

  res.json({ text: reply });
});

app.listen(10000, () => console.log("OlympeUS API ready"));
