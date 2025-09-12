// server.js  (CommonJS, Node 18+)
const express = require("express");
const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const app = express();
app.use(express.json());

// ======== CONFIG – keep these in sync with the dashboard ========
const VERIFY_TOKEN = "mysupersecret";                 // must match "Verify token" you enter in Meta UI
const ACCESS_TOKEN = "EAAPH4w3wjZBoBPWmW44lZB9ZCPjq1AJF3DAu6sb83Sf2yV43nIxATHsn8szutoOGot24bVAWQY3CoD47mmCV42VhJRZBNGZAegKJ5JW44lzaSZAbvJFuE89NpEE8hqWbrmCDmL0aJx8548wFtBnOxZBSifJYV9H8ehCmp1mO16CyoNsz30AI8sEBUqnRt2DpaRMVZC9q2pYwSUFwmOCDoZBIEWZBs8UCghlSclJQq4QoV1DyRyeeUUjCATvdFLNAZDZD";
const PHONE_NUMBER_ID = "755804770955343";
// ================================================================

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
          text: { body: `You said: ${text}` },
        }),
      });
    }
    res.sendStatus(200); // ACK quickly
  } catch (e) {
    console.error("POST /webhook error:", e);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook running on http://localhost:${PORT}`));
