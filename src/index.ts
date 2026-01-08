import type { Env, Agent } from "./types";
import { parseEmail } from "./email-parser";
import { routeEmail } from "./router";
import { dispatchToAgent } from "./dispatcher";
import { saveEmailRecord, getRecentEmails, getEmailRecord, getEmailStats, searchEmails } from "./email-history";
import { addToRetryQueue, processRetryQueue, getQueueStats, getRetryItems, getDeadLetterItems } from "./retry-queue";
import { checkRateLimit, getClientId, rateLimitResponse, DEFAULT_CONFIG, STRICT_CONFIG } from "./rate-limiter";
import { verifyApiKey, unauthorizedResponse } from "./auth";

export default {
  // Handle incoming emails
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const startTime = Date.now();
    console.log("=".repeat(60));
    console.log("[MOPERATOR] EMAIL RECEIVED");
    console.log("=".repeat(60));
    console.log(`[EMAIL] From: ${message.from}`);
    console.log(`[EMAIL] To: ${message.to}`);
    console.log(`[EMAIL] Headers: ${JSON.stringify(Object.fromEntries(message.headers))}`);

    // Parse the email
    console.log("[PARSE] Parsing email content...");
    const email = await parseEmail(message);
    console.log(`[PARSE] Subject: "${email.subject}"`);
    console.log(`[PARSE] Body preview: "${email.textBody.slice(0, 200)}..."`);
    console.log(`[PARSE] Attachments: ${email.attachments.length}`);

    // Get active agents from registry
    console.log("[REGISTRY] Fetching active agents...");
    const agents = await getActiveAgents(env.AGENT_REGISTRY);
    console.log(`[REGISTRY] Found ${agents.length} active agents: ${agents.map(a => a.id).join(", ")}`);

    if (agents.length === 0) {
      console.error("[ERROR] No agents registered, email will be dropped");
      return;
    }

    // Route email using Claude
    console.log("[ROUTER] Calling Claude for routing decision...");
    const decision = await routeEmail(email, agents, env.ANTHROPIC_API_KEY);
    console.log(`[ROUTER] Decision: ${decision.agentId}`);
    console.log(`[ROUTER] Reason: ${decision.reason}`);

    // Find the target agent
    const targetAgent = agents.find((a) => a.id === decision.agentId);
    if (!targetAgent) {
      console.error(`[ERROR] Agent ${decision.agentId} not found in registry`);
      return;
    }

    // Dispatch to agent
    console.log(`[DISPATCH] Sending to ${targetAgent.name} at ${targetAgent.webhookUrl}`);
    const result = await dispatchToAgent(
      email,
      targetAgent,
      decision.reason,
      env.WEBHOOK_SIGNING_KEY
    );

    const duration = Date.now() - startTime;

    // Save to email history
    await saveEmailRecord(env.EMAIL_HISTORY, email, decision, result, duration);

    if (result.success) {
      console.log(`[DISPATCH] SUCCESS - Status: ${result.statusCode}`);
      console.log(`[COMPLETE] Email processed in ${duration}ms`);
    } else {
      console.error(`[DISPATCH] FAILED - ${result.error || `Status: ${result.statusCode}`}`);

      // Add to retry queue
      await addToRetryQueue(
        env.RETRY_QUEUE,
        email,
        targetAgent.id,
        targetAgent.webhookUrl,
        decision.reason,
        result.error || `Status: ${result.statusCode}`
      );
    }
    console.log("=".repeat(60));
  },

  // Scheduled handler for retry processing
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    console.log("[CRON] Starting retry queue processing...");
    const stats = await processRetryQueue(env.RETRY_QUEUE, env.WEBHOOK_SIGNING_KEY);
    console.log(`[CRON] Processed: ${stats.processed}, Succeeded: ${stats.succeeded}, Failed: ${stats.failed}, Dead Lettered: ${stats.deadLettered}`);
  },

  // HTTP API for managing agents
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const clientId = getClientId(request);

    // Health check (no rate limit, no auth)
    if (url.pathname === "/health") {
      return json({ status: "ok", service: "moperator" });
    }

    // ================== RATE LIMITING ==================
    // Use RATE_LIMIT KV if available, fallback to AGENT_REGISTRY for storage
    const rateLimitKv = env.RATE_LIMIT || env.AGENT_REGISTRY;

    // Determine rate limit config based on request type
    const isWriteOperation = request.method === "POST" || request.method === "DELETE";
    const config = isWriteOperation ? STRICT_CONFIG : DEFAULT_CONFIG;

    const rateLimit = await checkRateLimit(rateLimitKv, clientId, config);
    if (!rateLimit.allowed) {
      console.log(`[RATE_LIMIT] Blocked ${clientId} - exceeded ${config.maxRequests} requests/min`);
      return rateLimitResponse(rateLimit.resetAt);
    }

    // ================== AGENT ENDPOINTS ==================

    // List agents
    if (url.pathname === "/agents" && request.method === "GET") {
      const agents = await getActiveAgents(env.AGENT_REGISTRY);
      return json({ agents });
    }

    // Register agent (requires API key)
    if (url.pathname === "/agents" && request.method === "POST") {
      if (!verifyApiKey(request, env.API_KEY)) {
        return unauthorizedResponse();
      }

      let body: Partial<Agent>;
      try {
        body = (await request.json()) as Partial<Agent>;
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      if (!body.id || !body.name || !body.webhookUrl || !body.description) {
        return json({ error: "Missing required fields: id, name, description, webhookUrl" }, 400);
      }

      // Validate agent ID format (alphanumeric, dashes, underscores only)
      if (!/^[a-zA-Z0-9_-]+$/.test(body.id)) {
        return json({ error: "Invalid agent ID format. Use only letters, numbers, dashes, and underscores." }, 400);
      }

      // Validate webhook URL
      try {
        new URL(body.webhookUrl);
      } catch {
        return json({ error: "Invalid webhookUrl format" }, 400);
      }

      const agent: Agent = {
        id: body.id,
        name: body.name.slice(0, 100), // Limit name length
        description: body.description.slice(0, 500), // Limit description length
        webhookUrl: body.webhookUrl,
        active: body.active ?? true,
      };

      await env.AGENT_REGISTRY.put(`agent:${agent.id}`, JSON.stringify(agent));
      return json({ agent }, 201);
    }

    // Delete agent (requires API key)
    if (url.pathname.startsWith("/agents/") && request.method === "DELETE") {
      if (!verifyApiKey(request, env.API_KEY)) {
        return unauthorizedResponse();
      }

      const agentId = url.pathname.split("/")[2];
      if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
        return json({ error: "Invalid agent ID" }, 400);
      }

      await env.AGENT_REGISTRY.delete(`agent:${agentId}`);
      return json({ deleted: agentId });
    }

    // ================== EMAIL HISTORY ENDPOINTS ==================

    // Get email stats
    if (url.pathname === "/emails/stats" && request.method === "GET") {
      const stats = await getEmailStats(env.EMAIL_HISTORY);
      return json(stats);
    }

    // List recent emails
    if (url.pathname === "/emails" && request.method === "GET") {
      const limitParam = url.searchParams.get("limit") || "20";
      const offsetParam = url.searchParams.get("offset") || "0";

      // Validate and sanitize pagination params
      const limit = Math.min(Math.max(1, parseInt(limitParam) || 20), 100); // 1-100
      const offset = Math.max(0, parseInt(offsetParam) || 0);

      const { emails, total } = await getRecentEmails(env.EMAIL_HISTORY, limit, offset);
      return json({ emails, total, limit, offset });
    }

    // Search emails
    if (url.pathname === "/emails/search" && request.method === "GET") {
      // Sanitize search params (limit length to prevent abuse)
      const from = (url.searchParams.get("from") || "").slice(0, 200) || undefined;
      const subject = (url.searchParams.get("subject") || "").slice(0, 200) || undefined;
      const agentId = (url.searchParams.get("agentId") || "").slice(0, 100) || undefined;

      const emails = await searchEmails(env.EMAIL_HISTORY, { from, subject, agentId });
      return json({ emails, count: emails.length });
    }

    // Get single email by ID
    if (url.pathname.match(/^\/emails\/[\w-]+$/) && request.method === "GET") {
      const emailId = url.pathname.split("/")[2];

      // Validate email ID format
      if (!emailId || !/^[\w-]+$/.test(emailId)) {
        return json({ error: "Invalid email ID format" }, 400);
      }

      const record = await getEmailRecord(env.EMAIL_HISTORY, emailId);
      if (!record) {
        return json({ error: "Email not found" }, 404);
      }
      return json(record);
    }

    // ================== RETRY QUEUE ENDPOINTS ==================

    // Get retry queue stats
    if (url.pathname === "/retry/stats" && request.method === "GET") {
      const stats = await getQueueStats(env.RETRY_QUEUE);
      return json(stats);
    }

    // List pending retries
    if (url.pathname === "/retry/pending" && request.method === "GET") {
      const items = await getRetryItems(env.RETRY_QUEUE);
      return json({ items, count: items.length });
    }

    // List dead letter items
    if (url.pathname === "/retry/dead" && request.method === "GET") {
      const items = await getDeadLetterItems(env.RETRY_QUEUE);
      return json({ items, count: items.length });
    }

    // Manually trigger retry processing (requires API key)
    if (url.pathname === "/retry/process" && request.method === "POST") {
      if (!verifyApiKey(request, env.API_KEY)) {
        return unauthorizedResponse();
      }

      const stats = await processRetryQueue(env.RETRY_QUEUE, env.WEBHOOK_SIGNING_KEY);
      return json(stats);
    }

    // ================== TEST ENDPOINTS ==================

    // Test routing (simulates email routing without actual email)
    // Requires API key since it consumes Claude API credits
    if (url.pathname === "/test-route" && request.method === "POST") {
      if (!verifyApiKey(request, env.API_KEY)) {
        return unauthorizedResponse();
      }

      let body: { from?: string; subject?: string; body?: string };
      try {
        body = (await request.json()) as { from?: string; subject?: string; body?: string };
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      // Sanitize and limit input sizes
      const simulatedEmail = {
        from: (body.from || "test@example.com").slice(0, 200),
        to: "inbox@moperator.ai",
        subject: (body.subject || "Test email").slice(0, 500),
        textBody: (body.body || "").slice(0, 10000), // Limit body to 10KB
        attachments: [],
        receivedAt: new Date().toISOString(),
      };

      const agents = await getActiveAgents(env.AGENT_REGISTRY);
      if (agents.length === 0) {
        return json({ error: "No agents registered" }, 400);
      }

      const decision = await routeEmail(simulatedEmail, agents, env.ANTHROPIC_API_KEY);

      return json({
        email: simulatedEmail,
        routing: decision,
        availableAgents: agents.map((a) => ({ id: a.id, name: a.name })),
      });
    }

    return json({ error: "Not found" }, 404);
  },
};

async function getActiveAgents(kv: KVNamespace): Promise<Agent[]> {
  const list = await kv.list({ prefix: "agent:" });
  const agents: Agent[] = [];

  for (const key of list.keys) {
    const data = await kv.get(key.name);
    if (data) {
      const agent = JSON.parse(data) as Agent;
      if (agent.active) {
        agents.push(agent);
      }
    }
  }

  return agents;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
