// server.js  (CommonJS, Node 18+)
const express = require("express");
const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));
const OpenAI = require("openai");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json());

// ======== CONFIG – read from environment variables ========
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
// ================================================================

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// MongoDB connection
let db;
const client = new MongoClient(MONGODB_URI);

// Connect to MongoDB
async function connectToMongoDB() {
  try {
    await client.connect();
    db = client.db("whatsapp-bot");
    console.log("Connected to MongoDB successfully");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
}

// Initialize database connection
connectToMongoDB();

// Simple root to confirm server is up
app.get("/", (_req, res) => res.status(200).send("OK"));

// 1) Verification endpoint (Meta calls this once when you save the webhook)
app.get("/webhook", (req, res) => {
  console.log("VERIFY query:", req.query);
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2) Incoming message notifications
app.post("/webhook", async (req, res) => {
  try {
    console.log("INCOMING BODY:", JSON.stringify(req.body, null, 2));
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    const from = message?.from;
    const text = message?.text?.body || "";

    if (from && text) {
      try {
        // Get or create conversation history for this customer from MongoDB
        const conversations = db.collection("conversations");
        let conversation = await conversations.findOne({ phoneNumber: from });
        
        if (!conversation) {
          // Create new conversation
          conversation = {
            phoneNumber: from,
            messages: [],
            lastUpdated: new Date()
          };
          await conversations.insertOne(conversation);
        }
        
        // Add customer message to history
        const userMessage = {
          role: "user",
          content: text,
          timestamp: new Date()
        };
        
        await conversations.updateOne(
          { phoneNumber: from },
          { 
            $push: { messages: userMessage },
            $set: { lastUpdated: new Date() }
          }
        );
        
        // Get updated conversation for GPT context
        conversation = await conversations.findOne({ phoneNumber: from });
        const customerHistory = conversation.messages;
        
        // Build messages array with system prompt and conversation history
        const messages = [
          {
            role: "system",
            content: "You are a helpful customer service assistant. Respond concisely and professionally to customer inquiries. Remember the conversation context and provide relevant responses based on previous messages."
          },
          ...customerHistory.slice(-10) // Keep last 10 messages to avoid token limits
        ];

        // Get response from OpenAI
        const completion = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: messages,
          max_tokens: 200,
          temperature: 0.7,
        });

        const gptResponse = completion.choices[0].message.content;

        // Add bot response to history
        const botMessage = {
          role: "assistant",
          content: gptResponse,
          timestamp: new Date()
        };
        
        await conversations.updateOne(
          { phoneNumber: from },
          { 
            $push: { messages: botMessage },
            $set: { lastUpdated: new Date() }
          }
        );

        // Keep only last 20 messages to prevent database bloat
        const updatedConversation = await conversations.findOne({ phoneNumber: from });
        if (updatedConversation.messages.length > 20) {
          const recentMessages = updatedConversation.messages.slice(-20);
          await conversations.updateOne(
            { phoneNumber: from },
            { $set: { messages: recentMessages } }
          );
        }

        // Send GPT response via WhatsApp
        await fetch(`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: from,
            type: "text",
            text: { body: gptResponse },
          }),
        });

        console.log(`Conversation with ${from}: ${updatedConversation.messages.length} messages`);
      } catch (gptError) {
        console.error("OpenAI API error:", gptError);
        // Fallback to simple response if OpenAI fails
        await fetch(`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: from,
            type: "text",
            text: { body: "I'm sorry, I'm having trouble processing your request right now. Please try again later." },
          }),
        });
      }
    }
    res.sendStatus(200); // ACK quickly
  } catch (e) {
    console.error("POST /webhook error:", e);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook running on http://localhost:${PORT}`));
