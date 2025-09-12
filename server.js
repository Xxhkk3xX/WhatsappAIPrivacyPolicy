// server.js  (CommonJS, Node 18+)
const express = require("express");
const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));
const OpenAI = require("openai");
const { MongoClient, ServerApiVersion } = require("mongodb");

const app = express();
app.use(express.json());

// ======== CONFIG – read from environment variables ========
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI;

// Debug: Check if MongoDB URI is properly set
console.log("MONGODB_URI exists:", !!MONGODB_URI);
console.log("MONGODB_URI starts with mongodb:", MONGODB_URI?.startsWith('mongodb'));
console.log("MONGODB_URI length:", MONGODB_URI?.length);
// ================================================================

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// MongoDB connection
let db;
let client;

// In-memory conversation history (fallback when MongoDB is unavailable)
const conversationHistory = new Map();

// Track processed messages to prevent duplicates
const processedMessages = new Set();

// Connect to MongoDB
async function connectToMongoDB() {
  if (!MONGODB_URI) {
    console.log("⚠️  MONGODB_URI not set - running without database (fallback mode)");
    return;
  }

  if (!MONGODB_URI.startsWith('mongodb')) {
    console.error("❌ Invalid MONGODB_URI format - must start with 'mongodb://' or 'mongodb+srv://'");
    console.log("Current MONGODB_URI:", MONGODB_URI);
    return;
  }

  try {
    client = new MongoClient(MONGODB_URI, {
      retryWrites: true,
      w: 'majority'
    });
    
    console.log("Attempting to connect to MongoDB...");
    await client.connect();
    db = client.db("whatsapp-bot");
    
    // Test the connection
    await db.admin().ping();
    console.log("✅ Connected to MongoDB successfully");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message);
    console.log("⚠️  Running without database (fallback mode)");
    db = null;
    client = null;
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
    
    // Only process webhooks that contain actual messages, not status updates
    if (!message) {
      console.log("Webhook contains no message, skipping (likely status update)");
      return;
    }
    
    const from = message?.from;
    const text = message?.text?.body || "";
    const messageId = message?.id;

    // Only process actual text messages
    if (from && text && messageId && message?.type === "text") {
      // Check if we've already processed this message
      if (processedMessages.has(messageId)) {
        console.log(`Message ${messageId} already processed, skipping`);
        return;
      }
      
      // Mark message as processed
      processedMessages.add(messageId);
      
      try {
        // Check if MongoDB is available, if not use in-memory storage
        if (!db) {
          console.log("MongoDB not available, using in-memory storage");
          
          // Get or create conversation history for this customer in memory
          if (!conversationHistory.has(from)) {
            conversationHistory.set(from, []);
          }
          
          const customerHistory = conversationHistory.get(from);
          
          // Add customer message to history
          customerHistory.push({
            role: "user",
            content: text,
            timestamp: new Date()
          });
          
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
          customerHistory.push({
            role: "assistant",
            content: gptResponse,
            timestamp: new Date()
          });

          // Keep only last 20 messages to prevent memory bloat
          if (customerHistory.length > 20) {
            customerHistory.splice(0, customerHistory.length - 20);
          }

          // Send GPT response via WhatsApp
          try {
            const response = await fetch(`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`, {
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
            
            if (response.ok) {
              console.log("✅ In-memory GPT response sent successfully");
            } else {
              console.error("❌ Failed to send in-memory GPT response:", response.status, await response.text());
            }
          } catch (error) {
            console.error("❌ Error sending in-memory GPT response:", error);
          }

          console.log(`In-memory conversation with ${from}: ${customerHistory.length} messages`);
          return;
        }

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
        try {
          const response = await fetch(`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`, {
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
          
          if (response.ok) {
            console.log("✅ GPT response sent successfully");
          } else {
            console.error("❌ Failed to send GPT response:", response.status, await response.text());
          }
        } catch (error) {
          console.error("❌ Error sending GPT response:", error);
        }

        console.log(`Conversation with ${from}: ${updatedConversation.messages.length} messages`);
      } catch (gptError) {
        console.error("OpenAI API error:", gptError);
        // Fallback to simple response if OpenAI fails
        try {
          const response = await fetch(`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`, {
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
          
          if (response.ok) {
            console.log("✅ Error fallback response sent successfully");
          } else {
            console.error("❌ Failed to send error fallback response:", response.status, await response.text());
          }
        } catch (error) {
          console.error("❌ Error sending error fallback response:", error);
        }
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
