import express from "express";
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 3000;

// Must match the WEBHOOK_SIGNING_KEY set in Moperator
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "my-super-secret-key-12345";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Initialize Anthropic client
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// Parse JSON bodies
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", agent: "moperator-agent-example" });
});

// Webhook endpoint for receiving emails from Moperator
app.post("/webhook", async (req, res) => {
  const startTime = Date.now();
  console.log("\n" + "=".repeat(60));
  console.log("[AGENT] WEBHOOK RECEIVED");
  console.log("=".repeat(60));

  // Get signature from headers
  const signature = req.headers["x-moperator-signature"];
  const timestamp = req.headers["x-moperator-timestamp"];

  console.log(`[AGENT] Timestamp: ${timestamp}`);
  console.log(`[AGENT] Signature: ${signature?.slice(0, 20)}...`);

  // Verify signature
  const payload = req.body;
  const { signature: _, ...payloadWithoutSig } = payload;
  const payloadString = JSON.stringify(payloadWithoutSig);

  const expectedSig = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(payloadString)
    .digest("hex");

  if (signature !== expectedSig) {
    console.error("[AGENT] SIGNATURE MISMATCH!");
    console.error(`[AGENT] Expected: ${expectedSig.slice(0, 20)}...`);
    console.error(`[AGENT] Got: ${signature?.slice(0, 20)}...`);
    return res.status(401).json({ error: "Invalid signature" });
  }

  console.log("[AGENT] Signature verified!");

  // Extract email details
  const { email, routedTo, routingReason } = payload;

  console.log(`[AGENT] From: ${email.from}`);
  console.log(`[AGENT] To: ${email.to}`);
  console.log(`[AGENT] Subject: ${email.subject}`);
  console.log(`[AGENT] Routed to: ${routedTo}`);
  console.log(`[AGENT] Reason: ${routingReason}`);
  console.log(`[AGENT] Body preview: ${email.textBody?.slice(0, 200)}...`);
  console.log(`[AGENT] Attachments: ${email.attachments?.length || 0}`);

  // Process with Claude if API key is available
  if (anthropic) {
    console.log("[AGENT] Processing with Claude...");
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: `You are an email processing agent. Analyze this email and provide a brief summary and suggested action.

From: ${email.from}
Subject: ${email.subject}
Body: ${email.textBody?.slice(0, 2000)}

Respond with:
1. Brief summary (1-2 sentences)
2. Category (e.g., "newsletter", "invoice", "support request", "spam", etc.)
3. Suggested action (e.g., "archive", "reply needed", "forward to team", etc.)`,
          },
        ],
      });

      const analysis = response.content[0].text;
      console.log("[AGENT] Claude Analysis:");
      console.log(analysis);
    } catch (err) {
      console.error("[AGENT] Claude error:", err.message);
    }
  } else {
    console.log("[AGENT] No ANTHROPIC_API_KEY set, skipping Claude analysis");
  }

  const duration = Date.now() - startTime;
  console.log(`[AGENT] Processed in ${duration}ms`);
  console.log("=".repeat(60) + "\n");

  // Respond to Moperator
  res.json({
    success: true,
    message: "Email received and processed",
    processingTime: duration,
  });
});

// Start server
app.listen(PORT, () => {
  console.log("=".repeat(60));
  console.log("MOPERATOR AGENT EXAMPLE");
  console.log("=".repeat(60));
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhook`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log("");
  console.log("Environment:");
  console.log(`  WEBHOOK_SECRET: ${WEBHOOK_SECRET ? "set" : "NOT SET"}`);
  console.log(`  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? "set" : "NOT SET"}`);
  console.log("");
  console.log("To expose publicly, use ngrok:");
  console.log(`  ngrok http ${PORT}`);
  console.log("=".repeat(60));
});
