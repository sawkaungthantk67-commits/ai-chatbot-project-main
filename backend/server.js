import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();

const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for PostgreSQL.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

async function createTables() {
  await pool.query(`
      CREATE TABLE IF NOT EXISTS faq_items (
        id SERIAL PRIMARY KEY,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        keywords TEXT NOT NULL,
        category VARCHAR(100),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255),
        user_message TEXT NOT NULL,
        bot_reply TEXT NOT NULL,
        answer_source VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  await seedFAQs();
}

async function seedFAQs() {
  const count = (await pool.query("SELECT COUNT(*) AS count FROM faq_items")).rows[0].count;

  if (Number(count) > 0) return;

  const faqs = [
    ["What sizes do you have?", "We offer T-shirt sizes S, M, L, XL, and XXL.", "size,sizes,tshirt size,shirt size", "product"],
    ["How long does delivery take?", "Standard delivery usually takes 3 to 5 working days.", "delivery,shipping,shipping time,delivery time", "delivery"],
    ["Can I customize my T-shirt?", "Yes. Custom text and selected designs are available. Please contact the shop for details.", "custom,customize,design,printing", "customization"],
    ["What payment methods do you accept?", "We accept cash and available local digital payment methods.", "payment,pay,cash,digital payment", "payment"],
    ["What is your return policy?", "Please contact us within 7 days of delivery if an item is damaged or incorrect.", "return,refund,exchange,wrong item,damaged", "returns"]
  ];

  for (const faq of faqs) {
    await pool.query(
      "INSERT INTO faq_items (question, answer, keywords, category) VALUES ($1, $2, $3, $4)",
      faq
    );
  }
}

async function findRelevantFAQs(message) {
  const text = message.toLowerCase();
  const result = await pool.query("SELECT question, answer, keywords FROM faq_items WHERE is_active = TRUE");

  return result.rows
    .map((row) => {
      const score = row.keywords
        .split(",")
        .map((keyword) => keyword.trim().toLowerCase())
        .filter((keyword) => keyword && text.includes(keyword))
        .length;
      return { ...row, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_API_KEY) return next();
  if (req.get("x-admin-key") === process.env.ADMIN_API_KEY) return next();
  res.status(401).json({ error: "Admin authentication required." });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, database: "postgresql" });
});

app.get("/api/faq", async (req, res) => {
  try {
    const rows = (await pool.query("SELECT id, question, answer, keywords, category, is_active, created_at FROM faq_items ORDER BY id ASC")).rows;
    res.json(rows);
  } catch (error) {
    console.error("FAQ fetch error:", error);
    res.status(500).json({ error: "Failed to fetch FAQ data." });
  }
});

app.post("/api/faq", requireAdmin, async (req, res) => {
  try {
    const { question, answer, keywords, category } = req.body;
    if (!question?.trim() || !answer?.trim() || !keywords?.trim()) {
      return res.status(400).json({ error: "question, answer, and keywords are required." });
    }

    const result = await pool.query(
      "INSERT INTO faq_items (question, answer, keywords, category) VALUES ($1, $2, $3, $4) RETURNING *",
      [question.trim(), answer.trim(), keywords.trim(), category?.trim() || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("FAQ insert error:", error);
    res.status(500).json({ error: "Failed to insert FAQ data." });
  }
});

app.get("/api/logs", async (req, res) => {
  try {
    const rows = (await pool.query("SELECT user_message, bot_reply, answer_source, created_at FROM chat_messages ORDER BY created_at DESC")).rows;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(rows.map((log, index) =>
      `Log ${index + 1}\nUser Message: ${log.user_message}\nBot Reply: ${log.bot_reply}\nAnswer Source: ${log.answer_source}\nCreated At: ${log.created_at}\n----------------------------------------`
    ).join("\n\n"));
  } catch (error) {
    console.error("Log fetch error:", error);
    res.status(500).send("Failed to fetch chat logs.");
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "Message is required." });

    const faqs = await findRelevantFAQs(message);
    let reply;
    let source;

    if (process.env.OPENROUTER_API_KEY) {
      const context = faqs.length
        ? faqs.map((faq, index) => `Q${index + 1}: ${faq.question}\nA${index + 1}: ${faq.answer}`).join("\n\n")
        : "No relevant data found.";
      const systemPrompt = `You are a helpful AI assistant for a local T-shirt shop.
Use the context below to answer the user's question.
If the answer is in the context, use it.
If not, say you do not have exact business information.
Do not invent details.

Context:
${context}`;

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.FRONTEND_URL || "",
          "X-OpenRouter-Title": "AI FAQ Chatbot"
        },
        body: JSON.stringify({
          model: process.env.OPENROUTER_MODEL || "openrouter/auto",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message }
          ]
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "OpenRouter request failed");
      reply = data?.choices?.[0]?.message?.content || "Sorry, I could not generate a response.";
      source = faqs.length ? "rag+openrouter" : "openrouter";
    } else if (faqs.length) {
      reply = faqs[0].answer;
      source = "faq";
    } else {
      reply = "I do not have exact business information about that. Please contact the shop for assistance.";
      source = "fallback";
    }

    await pool.query(
      "INSERT INTO chat_messages (session_id, user_message, bot_reply, answer_source) VALUES ($1, $2, $3, $4)",
      [sessionId || "anonymous", message.trim(), reply, source]
    );

    res.json({ reply, source });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: error.message || "Chat failed" });
  }
});

createTables()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
