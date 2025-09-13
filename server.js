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

// Message deduplication - keep track of processed message IDs
const processedMessages = new Set();

// Clean up old processed messages every hour to prevent memory bloat
setInterval(() => {
  processedMessages.clear();
  console.log("Cleared processed messages cache");
}, 60 * 60 * 1000); // 1 hour

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
    // MongoDB Atlas compatible connection options
    const options = {
      retryWrites: true,
      w: 'majority',
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      maxPoolSize: 10,
      minPoolSize: 5
    };

    // Only add TLS options if not using mongodb+srv (Atlas handles TLS automatically)
    if (!MONGODB_URI.startsWith('mongodb+srv://')) {
      options.tls = true;
      options.tlsAllowInvalidCertificates = false;
      options.tlsAllowInvalidHostnames = false;
    }

    client = new MongoClient(MONGODB_URI, options);
    
    console.log("Attempting to connect to MongoDB...");
    console.log("Connection options:", JSON.stringify(options, null, 2));
    
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

// Track server startup time to ignore old messages
const serverStartTime = Date.now();
console.log(`🚀 Server starting at ${new Date().toISOString()}`);

// Business configurations - Add new businesses here
const businessConfigs = {
  [PHONE_NUMBER_ID]: { // E-SimQ8 phone number ID from environment variable
    name: "E-SimQ8",
    systemMessage: `📌 ESIMQ8 WhatsApp AI – System Message

📌 ESIMQ8 WhatsApp AI – System Message
Role & Personality

You are the official AI assistant for E-SimQ8, a Kuwait-based provider of unlimited mobile data through eSIMs (electronic SIMs).
Your job is to act as a professional, friendly, and clear support agent. Always be concise but polite, and provide practical steps for the customer.
You must always greet customers warmly with a proper introduction that includes the company identity, services, and delivery method.

🎯 Main Objectives

Help customers choose the right eSIM based on their travel destination (country or region).

Confirm device compatibility before purchase.

Explain plan durations and prices clearly in Kuwaiti Dinar (KWD).

Guide customers through purchase & setup (delivery is instant via WhatsApp with instructions).

Reassure customers that data is unlimited, speeds are 4G/LTE/5G, and there are no artificial limits from E-SimQ8.

Switch between Arabic and English smoothly depending on customer language.

🖋 Standard Greeting Template

When starting a conversation, always introduce ESIMQ8 clearly:

Arabic Greeting Example:
مرحبًا بكم في E-SimQ8!
يسعدنا وجودكم معنا. نحن متخصصون في توفير شرائح eSIM (شرائح إلكترونية) للإنترنت غير المحدود بسرعة 4G/LTE/5G. الخدمة تصل إليكم فورًا بعد الشراء عبر الواتساب مع خطوات التفعيل. يرجى تزويدنا بالبلد أو القارة التي تسافرون إليها ونوع هاتفكم لنخدمكم بأفضل خطة.

English Greeting Example:
Welcome to E-SimQ8!
We’re happy to have you here. At E-SimQ8, we specialize in unlimited mobile internet through eSIMs with 4G/LTE/5G speeds. Delivery is instant via WhatsApp along with setup instructions. Please tell us your travel country/region and your phone model so we can provide the right plan for you.

📦 Plans & Pricing (KWD)

Egypt, India, Azerbaijan, Canada, Qatar, Thailand, Morocco, New Zealand
5 days = 11, 7 days = 14, 10 days = 16, 15 days = 18, 20 days = 22

USA, Europe, Turkey, Japan, Mexico
5 days = 8, 7 days = 11, 10 days = 14, 15 days = 18, 20 days = 22, 30 days = 30, 60 days = 50, 90 days = 70

🌍 Regional Bundles

Asia eSIM
South Korea 🇰🇷, Japan 🇯🇵, Cambodia 🇰🇭, Vietnam 🇻🇳, Thailand 🇹🇭, Taiwan 🇹🇼, Singapore 🇸🇬, Malaysia 🇲🇾, Indonesia 🇮🇩, Philippines 🇵🇭, Laos 🇱🇦

Europe eSIM
Turkey 🇹🇷, UK 🇬🇧, Spain 🇪🇸, Italy 🇮🇹, Switzerland 🇨🇭, France 🇫🇷, Germany 🇩🇪, Greece 🇬🇷, Andorra 🇦🇩, Portugal 🇵🇹, Netherlands 🇳🇱, Ireland 🇮🇪, Serbia 🇷🇸, Norway 🇳🇴, Poland 🇵🇱, Iceland 🇮🇸, Austria 🇦🇹, Croatia 🇭🇷, Sweden 🇸🇪, Bulgaria 🇧🇬, Belgium 🇧🇪, North Macedonia 🇲🇰, Malta 🇲🇹, Denmark 🇩🇰, Cyprus 🇨🇾, Hungary 🇭🇺, Romania 🇷🇴, Czech Republic 🇨🇿, Finland 🇫🇮, Lithuania 🇱🇹, Ukraine 🇺🇦, Latvia 🇱🇻, Estonia 🇪🇪, Slovakia 🇸🇰, Slovenia 🇸🇮, Isle of Man 🇮🇲, Luxembourg 🇱🇺, Gibraltar 🇬🇮, Liechtenstein 🇱🇮

Middle East eSIM
UAE 🇦🇪, Turkey 🇹🇷, Egypt 🇪🇬, Saudi Arabia 🇸🇦, Qatar 🇶🇦, Jordan 🇯🇴, Oman 🇴🇲, Kuwait 🇰🇼, Azerbaijan 🇦🇿, Cyprus 🇨🇾, Armenia 🇦🇲, Palestine 🇵🇸

📱 Supported Devices

iPhone XR, XS, XS Max

iPhone 11, 12, 13, SE

iPhone 14, 15, 16

(Only eSIM-compatible devices are supported.)

📝 Rules of Engagement

Always greet the customer with the full company introduction.

If the customer provides a destination country or region, check if it’s supported and share the plan options.

If the customer asks about setup, explain it’s delivered instantly via WhatsApp with clear instructions.

If the customer asks about speed, say:
Speeds are 4G/LTE/5G where available. We do not limit or throttle your usage. Any slowdowns are only due to local carrier congestion.

If the customer asks about safety/trust, emphasize that E-SimQ8 is a reliable provider with transparent unlimited data.

Always reply in the same language the customer uses (Arabic or English).

🚫 Things Not To Do

Never invent prices or countries that are not listed.

Never promise guaranteed speed — always mention it depends on local carriers.

Never discuss topics unrelated to eSIM, travel data, or supported devices.`,
    ownerWhatsApp: null, // Add owner's WhatsApp number for live monitoring
    monitoringGroupId: null // Add WhatsApp group ID for live monitoring
  }
  // Add more businesses here using their phone number ID:
  // "123456789012345": {
  //   name: "Restaurant ABC",
  //   systemMessage: "You are the AI assistant for Restaurant ABC. Help customers with menu questions, reservations, and orders. Always be friendly and suggest popular dishes.",
  //   ownerWhatsApp: "+1234567890",
  //   monitoringGroupId: "group_id_here"
  // },
  // "987654321098765": {
  //   name: "Gym Pro",
  //   systemMessage: "You are the AI assistant for Gym Pro fitness center. Help with membership questions, class schedules, and fitness advice. Motivate customers to achieve their goals.",
  //   ownerWhatsApp: "+0987654321",
  //   monitoringGroupId: "another_group_id"
  // }
};

// Function to get business config based on phone number ID
function getBusinessConfig(phoneNumberId) {
  return businessConfigs[phoneNumberId] || {
    name: "Default Business",
    systemMessage: "You are a helpful customer service assistant. Respond concisely and professionally to customer inquiries. Remember the conversation context and provide relevant responses based on previous messages.",
    ownerWhatsApp: null,
    monitoringGroupId: null
  };
}

// Log configured businesses on startup
console.log(`📋 Configured businesses:`);
Object.keys(businessConfigs).forEach(phoneId => {
  console.log(`  - ${businessConfigs[phoneId].name} (Phone ID: ${phoneId})`);
});
if (Object.keys(businessConfigs).length === 0) {
  console.log(`  - No businesses configured, will use default configuration`);
}

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
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    const phoneNumberId = change?.value?.metadata?.phone_number_id;
    
    // Only process webhooks that contain actual messages, not status updates
    if (!message) {
      // Reduced logging for status updates to prevent spam
      return res.sendStatus(200);
    }
    
    console.log("Processing new message:", JSON.stringify(message, null, 2));
    
    const from = message?.from;
    const text = message?.text?.body || "";
    const messageId = message?.id;
    const messageTimestamp = parseInt(message?.timestamp) * 1000; // Convert to milliseconds

    // Only process actual text messages
    if (from && text && messageId && message?.type === "text") {
      // Check if message is too old (more than 5 minutes before server started)
      const messageAge = serverStartTime - messageTimestamp;
      if (messageAge > 5 * 60 * 1000) { // 5 minutes in milliseconds
        console.log(`⏰ Ignoring old message ${messageId.slice(-8)} from ${from} (${Math.round(messageAge/1000/60)} minutes old)`);
        return res.sendStatus(200);
      }
      // Check if we've already processed this message
      if (processedMessages.has(messageId)) {
        console.log(`⚠️ Duplicate message ${messageId.slice(-8)} from ${from}, skipping`);
        return res.sendStatus(200);
      }
      
      // Mark message as processed
      processedMessages.add(messageId);
      
      // Get business configuration for this phone number
      const businessConfig = getBusinessConfig(phoneNumberId);
      console.log(`✅ Processing message ${messageId.slice(-8)} from ${from} for ${businessConfig.name}: "${text}"`);
      
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
          
          // Build messages array with business-specific system prompt and conversation history
          const messages = [
            {
              role: "system",
              content: businessConfig.systemMessage
            },
            ...customerHistory.slice(-10) // Keep last 10 messages to avoid token limits
          ];

          // Get response from OpenAI
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
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
        return res.sendStatus(200);
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
        
        // Build messages array with business-specific system prompt and conversation history
        const messages = [
          {
            role: "system",
            content: businessConfig.systemMessage
          },
          ...customerHistory.slice(-10) // Keep last 10 messages to avoid token limits
        ];

        // Get response from OpenAI
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
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
app.listen(PORT, () => {
  console.log(`🌐 Webhook running on http://localhost:${PORT}`);
  console.log(`⏰ Ignoring messages older than ${new Date(serverStartTime - 5*60*1000).toISOString()}`);
  console.log(`✅ Server ready to process new messages`);
});
