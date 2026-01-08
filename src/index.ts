import type { Env, Agent } from "./types";
import { parseEmail } from "./email-parser";
import { routeEmail } from "./router";
import { dispatchToAgent } from "./dispatcher";
import { saveEmailRecord, getRecentEmails, getEmailRecord, getEmailStats, searchEmails } from "./email-history";
import { addToRetryQueue, processRetryQueue, getQueueStats, getRetryItems, getDeadLetterItems } from "./retry-queue";
import { checkRateLimit, getClientId, rateLimitResponse, checkTenantRateLimit, DEFAULT_CONFIG, STRICT_CONFIG } from "./rate-limiter";
import { verifyApiKey, unauthorizedResponse } from "./auth";
import { checkAllAgentsHealth, checkAgentHealth, getHealthSummary, reEnableAgent } from "./health-check";
import type { AgentWithHealth } from "./health-check";

// Protocol imports
import { handleMCPHttp } from "./protocols/mcp";
import { handleAgentCardRequest, handleA2ATaskRequest, handleCapabilitiesRequest } from "./protocols/a2a";
import { handleOpenAPIRequest } from "./protocols/openapi";

// Tenant management
import {
  authenticateByApiKey,
  getTenantByEmail,
  createTenant,
  getTenant,
  listTenants,
  deleteTenant,
  regenerateApiKey,
  updateTenantSettings,
  incrementUsage,
  resetDailyUsage,
  tenantKey,
  type Tenant,
} from "./tenant";

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

    // Find tenant by destination email
    const tenant = await getTenantByEmail(env.TENANTS, message.to);
    if (!tenant) {
      console.error(`[ERROR] No tenant found for email: ${message.to}`);
      return;
    }
    console.log(`[TENANT] Routing for tenant: ${tenant.id} (${tenant.name})`);

    // Check daily email limit
    if (tenant.usage.emailsToday >= tenant.settings.maxEmailsPerDay) {
      console.error(`[ERROR] Tenant ${tenant.id} exceeded daily email limit (${tenant.settings.maxEmailsPerDay})`);
      return;
    }

    // Parse the email
    console.log("[PARSE] Parsing email content...");
    const email = await parseEmail(message);
    console.log(`[PARSE] Subject: "${email.subject}"`);
    console.log(`[PARSE] Body preview: "${email.textBody.slice(0, 200)}..."`);

    // Get tenant's active agents from registry
    console.log("[REGISTRY] Fetching tenant's active agents...");
    const agents = await getTenantAgents(env.AGENT_REGISTRY, tenant.id);
    console.log(`[REGISTRY] Found ${agents.length} active agents: ${agents.map(a => a.id).join(", ")}`);

    // Route email using Claude (or default if no/one agent)
    let decision;
    let targetAgent = null;

    if (agents.length === 0) {
      // No agents - still store email for MCP/Action access
      console.log("[ROUTER] No agents registered, storing for MCP/Action access");
      decision = { agentId: "none", reason: "No agents registered - stored for API access" };
    } else {
      console.log("[ROUTER] Calling Claude for routing decision...");
      decision = await routeEmail(email, agents, env.ANTHROPIC_API_KEY);
      console.log(`[ROUTER] Decision: ${decision.agentId}`);
      console.log(`[ROUTER] Reason: ${decision.reason}`);
      targetAgent = agents.find((a) => a.id === decision.agentId) || null;
    }

    const routingDuration = Date.now() - startTime;
    console.log(`[ROUTER] Routing completed in ${routingDuration}ms`);

    // STEP 1: Save to KV immediately (so MCP/Action users can access right away)
    // Webhook dispatch result will be updated after dispatch completes
    const pendingResult = { success: false, statusCode: 0, error: "Pending webhook dispatch" };
    const emailId = await saveTenantEmailRecord(
      env.EMAIL_HISTORY,
      tenant.id,
      email,
      decision,
      targetAgent ? pendingResult : { success: true, statusCode: 200 }, // No webhook = success
      routingDuration
    );
    console.log(`[STORE] Email saved to KV: ${emailId}`);

    // Update usage stats
    await incrementUsage(env.TENANTS, tenant.id, "emailsToday");
    await incrementUsage(env.TENANTS, tenant.id, "emailsTotal");

    // STEP 2: Dispatch to webhook (only if agent has a valid webhook URL)
    if (targetAgent && isValidWebhookUrl(targetAgent.webhookUrl)) {
      console.log(`[DISPATCH] Sending to ${targetAgent.name} at ${targetAgent.webhookUrl}`);
      const result = await dispatchToAgent(
        email,
        targetAgent,
        decision.reason,
        env.WEBHOOK_SIGNING_KEY
      );

      const totalDuration = Date.now() - startTime;

      // Update the stored record with dispatch result
      await updateEmailDispatchResult(env.EMAIL_HISTORY, tenant.id, emailId, result, totalDuration);

      if (result.success) {
        console.log(`[DISPATCH] SUCCESS - Status: ${result.statusCode}`);
      } else {
        console.error(`[DISPATCH] FAILED - ${result.error || `Status: ${result.statusCode}`}`);

        // Add to tenant-scoped retry queue
        await addToRetryQueue(
          env.RETRY_QUEUE,
          email,
          targetAgent.id,
          targetAgent.webhookUrl,
          decision.reason,
          result.error || `Status: ${result.statusCode}`,
          tenant.id
        );
      }
      console.log(`[COMPLETE] Email processed in ${totalDuration}ms`);
    } else {
      // No webhook dispatch needed
      const reason = !targetAgent ? "No agent matched" : "No valid webhook URL configured";
      console.log(`[SKIP] Webhook dispatch skipped: ${reason}`);
      console.log(`[COMPLETE] Email stored in ${routingDuration}ms (no webhook)`);
    }
    console.log("=".repeat(60));
  },

  // Scheduled handler for retry processing and health checks
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    // Run retry queue processing
    console.log("[CRON] Starting retry queue processing...");
    const retryStats = await processRetryQueue(env.RETRY_QUEUE, env.WEBHOOK_SIGNING_KEY);
    console.log(`[CRON] Retry: ${retryStats.processed} processed, ${retryStats.succeeded} succeeded, ${retryStats.failed} failed, ${retryStats.deadLettered} dead lettered`);

    // Run health checks on agents
    console.log("[CRON] Starting agent health checks...");
    const healthStats = await checkAllAgentsHealth(env.AGENT_REGISTRY);
    console.log(`[CRON] Health: ${healthStats.checked} checked, ${healthStats.healthy} healthy, ${healthStats.unhealthy} unhealthy, ${healthStats.disabled} disabled`);

    // Reset daily usage at midnight (check if triggered at midnight cron)
    const now = new Date();
    if (now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
      console.log("[CRON] Resetting daily usage counters...");
      const resetCount = await resetDailyUsage(env.TENANTS);
      console.log(`[CRON] Reset daily usage for ${resetCount} tenants`);
    }
  },

  // HTTP API for managing agents and protocols
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const clientId = getClientId(request);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // ================== PUBLIC ENDPOINTS ==================

    // Health check (no rate limit, no auth)
    if (url.pathname === "/health") {
      return json({ status: "ok", service: "moperator", version: "2.0.0" });
    }

    // OpenAPI spec for ChatGPT Custom GPT Actions
    if (url.pathname === "/openapi.json" || url.pathname === "/openapi.yaml") {
      return handleOpenAPIRequest(request);
    }

    // Privacy policy for ChatGPT Actions
    if (url.pathname === "/privacy") {
      return new Response(`<!DOCTYPE html>
<html>
<head>
  <title>Moperator Privacy Policy</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; line-height: 1.6; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
  </style>
</head>
<body>
  <h1>Moperator Privacy Policy</h1>
  <p><em>Last updated: January 2025</em></p>

  <h2>Overview</h2>
  <p>Moperator ("Email for AI") is an email infrastructure service for AI agents. This policy describes how we handle data when you use our service.</p>

  <h2>Data We Process</h2>
  <ul>
    <li><strong>Email Data:</strong> We receive and process emails sent to your Moperator address to route them to your configured AI agents.</li>
    <li><strong>API Usage:</strong> We log API requests for security and debugging purposes.</li>
    <li><strong>Account Info:</strong> Email address and API keys for authentication.</li>
  </ul>

  <h2>How We Use Data</h2>
  <ul>
    <li>Route incoming emails to your configured webhook endpoints</li>
    <li>Provide email history and search functionality via API</li>
    <li>Authenticate API requests</li>
  </ul>

  <h2>Data Retention</h2>
  <p>Email records are retained for 30 days. You can delete your account and associated data at any time.</p>

  <h2>Third Parties</h2>
  <p>We use Cloudflare for hosting and Anthropic Claude for email routing decisions. Emails are sent to webhook URLs you configure.</p>

  <h2>Contact</h2>
  <p>For privacy inquiries, contact the service administrator.</p>
</body>
</html>`, {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // A2A Agent Card (discovery endpoint)
    if (url.pathname === "/.well-known/agent.json") {
      return handleAgentCardRequest(request);
    }

    // A2A Capabilities (discovery endpoint)
    if (url.pathname === "/a2a/capabilities" && request.method === "GET") {
      return handleCapabilitiesRequest();
    }

    // ================== ADMIN ENDPOINTS (System-wide) ==================

    // Tenant management requires ADMIN_SECRET
    if (url.pathname.startsWith("/admin/")) {
      const adminSecret = request.headers.get("X-Admin-Secret");
      if (!adminSecret || adminSecret !== env.ADMIN_SECRET) {
        return json({ error: "Admin access required" }, 403);
      }

      // Apply admin rate limiting
      const rateLimitKv = env.RATE_LIMIT || env.AGENT_REGISTRY;
      const rateLimit = await checkRateLimit(rateLimitKv, `admin:${clientId}`, STRICT_CONFIG);
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.resetAt);
      }

      // List all tenants
      if (url.pathname === "/admin/tenants" && request.method === "GET") {
        const tenants = await listTenants(env.TENANTS);
        return json({ tenants: tenants.map(t => ({ ...t, apiKey: undefined })), count: tenants.length });
      }

      // Create tenant
      if (url.pathname === "/admin/tenants" && request.method === "POST") {
        try {
          const body = await request.json() as { id: string; name: string; email: string };
          if (!body.id || !body.name || !body.email) {
            return json({ error: "Missing required fields: id, name, email" }, 400);
          }
          const result = await createTenant(env.TENANTS, body);
          return json({ tenant: { ...result.tenant, apiKey: undefined }, apiKey: result.apiKey }, 201);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : "Failed to create tenant" }, 400);
        }
      }

      // Get specific tenant
      if (url.pathname.match(/^\/admin\/tenants\/[\w-]+$/) && request.method === "GET") {
        const tenantId = url.pathname.split("/")[3];
        const tenant = await getTenant(env.TENANTS, tenantId);
        if (!tenant) {
          return json({ error: "Tenant not found" }, 404);
        }
        return json({ tenant: { ...tenant, apiKey: undefined } });
      }

      // Regenerate tenant API key
      if (url.pathname.match(/^\/admin\/tenants\/[\w-]+\/regenerate-key$/) && request.method === "POST") {
        const tenantId = url.pathname.split("/")[3];
        const result = await regenerateApiKey(env.TENANTS, tenantId);
        if (!result) {
          return json({ error: "Tenant not found" }, 404);
        }
        return json({ apiKey: result.apiKey });
      }

      // Update tenant settings
      if (url.pathname.match(/^\/admin\/tenants\/[\w-]+\/settings$/) && request.method === "PATCH") {
        const tenantId = url.pathname.split("/")[3];
        const settings = await request.json();
        const tenant = await updateTenantSettings(env.TENANTS, tenantId, settings as any);
        if (!tenant) {
          return json({ error: "Tenant not found" }, 404);
        }
        return json({ tenant: { ...tenant, apiKey: undefined } });
      }

      // Delete tenant
      if (url.pathname.match(/^\/admin\/tenants\/[\w-]+$/) && request.method === "DELETE") {
        const tenantId = url.pathname.split("/")[3];
        const deleted = await deleteTenant(env.TENANTS, tenantId);
        if (!deleted) {
          return json({ error: "Tenant not found" }, 404);
        }
        return json({ deleted: tenantId });
      }

      return json({ error: "Admin endpoint not found" }, 404);
    }

    // ================== LEGACY ENDPOINTS (API_KEY auth, backwards compat) ==================
    // These endpoints use the old API_KEY authentication for system-wide management

    if (url.pathname === "/agents" || url.pathname.startsWith("/agents/") ||
        url.pathname === "/health/agents" || url.pathname.startsWith("/health/") ||
        url.pathname === "/emails" || url.pathname.startsWith("/emails/") ||
        url.pathname === "/retry" || url.pathname.startsWith("/retry/") ||
        url.pathname === "/test-route") {

      // Apply IP-based rate limiting for legacy endpoints
      const rateLimitKv = env.RATE_LIMIT || env.AGENT_REGISTRY;
      const isWriteOperation = request.method === "POST" || request.method === "DELETE";
      const config = isWriteOperation ? STRICT_CONFIG : DEFAULT_CONFIG;
      const rateLimit = await checkRateLimit(rateLimitKv, clientId, config);
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.resetAt);
      }

      return handleLegacyEndpoints(request, env, url);
    }

    // ================== AUTHENTICATED TENANT ENDPOINTS ==================

    // Extract and verify tenant API key
    const authHeader = request.headers.get("Authorization");
    const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!apiKey) {
      return json({ error: "Authorization required. Use Bearer token with your API key." }, 401);
    }

    const tenant = await authenticateByApiKey(env.TENANTS, apiKey);
    if (!tenant) {
      return json({ error: "Invalid API key" }, 401);
    }

    // Apply per-tenant rate limiting
    const rateLimitKv = env.RATE_LIMIT || env.AGENT_REGISTRY;
    const tenantRateLimit = await checkTenantRateLimit(rateLimitKv, tenant);
    if (!tenantRateLimit.allowed) {
      console.log(`[RATE_LIMIT] Blocked tenant ${tenant.id} - exceeded ${tenant.settings.rateLimitPerMinute} requests/min`);
      return rateLimitResponse(tenantRateLimit.resetAt);
    }

    // ================== PROTOCOL ENDPOINTS ==================

    // MCP endpoint for Claude Desktop (POST JSON-RPC)
    if (url.pathname === "/mcp" && request.method === "POST") {
      if (!tenant.settings.enabledProtocols.includes("mcp")) {
        return json({ error: "MCP protocol not enabled for this tenant" }, 403);
      }
      return handleMCPHttp(request, tenant, {
        agents: env.AGENT_REGISTRY,
        emails: env.EMAIL_HISTORY,
      });
    }

    // A2A task endpoint for Gemini
    if (url.pathname === "/a2a/tasks" && request.method === "POST") {
      if (!tenant.settings.enabledProtocols.includes("a2a")) {
        return json({ error: "A2A protocol not enabled for this tenant" }, 403);
      }
      return handleA2ATaskRequest(request, tenant, {
        agents: env.AGENT_REGISTRY,
        emails: env.EMAIL_HISTORY,
      });
    }

    // ================== TENANT API ENDPOINTS ==================

    // Get current tenant info
    if (url.pathname === "/api/v1/me" && request.method === "GET") {
      return json({
        tenant: {
          id: tenant.id,
          name: tenant.name,
          email: tenant.email,
          settings: tenant.settings,
          usage: tenant.usage,
          createdAt: tenant.createdAt,
        }
      });
    }

    // List tenant's agents
    if (url.pathname === "/api/v1/agents" && request.method === "GET") {
      const agents = await getTenantAgents(env.AGENT_REGISTRY, tenant.id);
      return json({ agents });
    }

    // Register agent for tenant
    if (url.pathname === "/api/v1/agents" && request.method === "POST") {
      // Check agent limit
      if (tenant.usage.agentCount >= tenant.settings.maxAgents) {
        return json({ error: `Maximum agents (${tenant.settings.maxAgents}) reached` }, 400);
      }

      let body: Partial<Agent>;
      try {
        body = await request.json() as Partial<Agent>;
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      if (!body.id || !body.name || !body.webhookUrl || !body.description) {
        return json({ error: "Missing required fields: id, name, description, webhookUrl" }, 400);
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(body.id)) {
        return json({ error: "Invalid agent ID format" }, 400);
      }

      try {
        new URL(body.webhookUrl);
      } catch {
        return json({ error: "Invalid webhookUrl format" }, 400);
      }

      const agent: Agent = {
        id: body.id,
        name: body.name.slice(0, 100),
        description: body.description.slice(0, 500),
        webhookUrl: body.webhookUrl,
        active: body.active ?? true,
      };

      // Store with tenant-scoped key
      await env.AGENT_REGISTRY.put(tenantKey(tenant.id, "agent", agent.id), JSON.stringify(agent));
      await incrementUsage(env.TENANTS, tenant.id, "agentCount");

      return json({ agent }, 201);
    }

    // Delete tenant's agent
    if (url.pathname.match(/^\/api\/v1\/agents\/[\w-]+$/) && request.method === "DELETE") {
      const agentId = url.pathname.split("/")[4];
      if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
        return json({ error: "Invalid agent ID" }, 400);
      }

      const key = tenantKey(tenant.id, "agent", agentId);
      const existing = await env.AGENT_REGISTRY.get(key);
      if (!existing) {
        return json({ error: "Agent not found" }, 404);
      }

      await env.AGENT_REGISTRY.delete(key);
      await incrementUsage(env.TENANTS, tenant.id, "agentCount", -1);

      return json({ deleted: agentId });
    }

    // List tenant's emails (compact by default for ChatGPT compatibility)
    if (url.pathname === "/api/v1/emails" && request.method === "GET") {
      const limitParam = url.searchParams.get("limit") || "10";
      const offsetParam = url.searchParams.get("offset") || "0";
      const limit = Math.min(Math.max(1, parseInt(limitParam) || 10), 50);
      const offset = Math.max(0, parseInt(offsetParam) || 0);

      const result = await getTenantEmails(env.EMAIL_HISTORY, tenant.id, limit, offset);
      // Return compact summaries to avoid response size limits
      const compactEmails = result.emails.map(compactEmailSummary);
      return json({ emails: compactEmails, total: result.total, limit, offset });
    }

    // Search tenant's emails
    if (url.pathname === "/api/v1/emails/search" && request.method === "GET") {
      const from = (url.searchParams.get("from") || "").slice(0, 200) || undefined;
      const subject = (url.searchParams.get("subject") || "").slice(0, 200) || undefined;
      const agentId = (url.searchParams.get("agentId") || "").slice(0, 100) || undefined;

      const emails = await searchTenantEmails(env.EMAIL_HISTORY, tenant.id, { from, subject, agentId });
      // Return compact summaries
      const compactEmails = emails.map(compactEmailSummary);
      return json({ emails: compactEmails, count: compactEmails.length });
    }

    // Get tenant's email by ID
    if (url.pathname.match(/^\/api\/v1\/emails\/[\w-]+$/) && request.method === "GET") {
      const emailId = url.pathname.split("/")[4];
      if (!emailId || !/^[\w-]+$/.test(emailId)) {
        return json({ error: "Invalid email ID format" }, 400);
      }

      const record = await getTenantEmailRecord(env.EMAIL_HISTORY, tenant.id, emailId);
      if (!record) {
        return json({ error: "Email not found" }, 404);
      }
      return json(record);
    }

    // Get tenant's email stats
    if (url.pathname === "/api/v1/emails/stats" && request.method === "GET") {
      const stats = await getTenantEmailStats(env.EMAIL_HISTORY, tenant.id);
      return json(stats);
    }

    return json({ error: "Not found" }, 404);
  },
};

// ================== LEGACY ENDPOINTS (backwards compatibility) ==================

async function handleLegacyEndpoints(request: Request, env: Env, url: URL): Promise<Response> {
  // ==================== AGENT ENDPOINTS ====================

  // List agents (public)
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
      body = await request.json() as Partial<Agent>;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.id || !body.name || !body.webhookUrl || !body.description) {
      return json({ error: "Missing required fields: id, name, description, webhookUrl" }, 400);
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(body.id)) {
      return json({ error: "Invalid agent ID format" }, 400);
    }

    try {
      new URL(body.webhookUrl);
    } catch {
      return json({ error: "Invalid webhookUrl format" }, 400);
    }

    const agent: Agent = {
      id: body.id,
      name: body.name.slice(0, 100),
      description: body.description.slice(0, 500),
      webhookUrl: body.webhookUrl,
      active: body.active ?? true,
    };

    await env.AGENT_REGISTRY.put(`agent:${agent.id}`, JSON.stringify(agent));
    return json({ agent }, 201);
  }

  // Re-enable agent (requires API key)
  if (url.pathname.startsWith("/agents/") && url.pathname.endsWith("/enable") && request.method === "POST") {
    if (!verifyApiKey(request, env.API_KEY)) {
      return unauthorizedResponse();
    }

    const agentId = url.pathname.split("/")[2];
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      return json({ error: "Invalid agent ID" }, 400);
    }

    const agent = await reEnableAgent(env.AGENT_REGISTRY, agentId);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    return json({ agent, message: "Agent re-enabled successfully" });
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

  // ==================== HEALTH CHECK ENDPOINTS ====================

  if (url.pathname === "/health/agents" && request.method === "GET") {
    const summary = await getHealthSummary(env.AGENT_REGISTRY);
    return json(summary);
  }

  if (url.pathname === "/health/check" && request.method === "POST") {
    if (!verifyApiKey(request, env.API_KEY)) {
      return unauthorizedResponse();
    }

    const stats = await checkAllAgentsHealth(env.AGENT_REGISTRY);
    return json(stats);
  }

  if (url.pathname.match(/^\/health\/agents\/[\w-]+$/) && request.method === "POST") {
    if (!verifyApiKey(request, env.API_KEY)) {
      return unauthorizedResponse();
    }

    const agentId = url.pathname.split("/")[3];
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      return json({ error: "Invalid agent ID" }, 400);
    }

    const data = await env.AGENT_REGISTRY.get(`agent:${agentId}`);
    if (!data) {
      return json({ error: "Agent not found" }, 404);
    }

    const agent = JSON.parse(data) as AgentWithHealth;
    const status = await checkAgentHealth(env.AGENT_REGISTRY, agent);
    return json({ agentId, health: status });
  }

  // ==================== EMAIL HISTORY ENDPOINTS ====================

  // Get email stats
  if (url.pathname === "/emails/stats" && request.method === "GET") {
    const stats = await getEmailStats(env.EMAIL_HISTORY);
    return json(stats);
  }

  // List recent emails
  if (url.pathname === "/emails" && request.method === "GET") {
    const limitParam = url.searchParams.get("limit") || "20";
    const offsetParam = url.searchParams.get("offset") || "0";
    const limit = Math.min(Math.max(1, parseInt(limitParam) || 20), 100);
    const offset = Math.max(0, parseInt(offsetParam) || 0);

    const { emails, total } = await getRecentEmails(env.EMAIL_HISTORY, limit, offset);
    return json({ emails, total, limit, offset });
  }

  // Search emails
  if (url.pathname === "/emails/search" && request.method === "GET") {
    const from = (url.searchParams.get("from") || "").slice(0, 200) || undefined;
    const subject = (url.searchParams.get("subject") || "").slice(0, 200) || undefined;
    const agentId = (url.searchParams.get("agentId") || "").slice(0, 100) || undefined;

    const emails = await searchEmails(env.EMAIL_HISTORY, { from, subject, agentId });
    return json({ emails, count: emails.length });
  }

  // Get single email by ID
  if (url.pathname.match(/^\/emails\/[\w-]+$/) && request.method === "GET") {
    const emailId = url.pathname.split("/")[2];
    if (!emailId || !/^[\w-]+$/.test(emailId)) {
      return json({ error: "Invalid email ID format" }, 400);
    }

    const record = await getEmailRecord(env.EMAIL_HISTORY, emailId);
    if (!record) {
      return json({ error: "Email not found" }, 404);
    }
    return json(record);
  }

  // ==================== RETRY QUEUE ENDPOINTS ====================

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

  // ==================== TEST ENDPOINTS ====================

  // Test routing (requires API key since it consumes Claude API credits)
  if (url.pathname === "/test-route" && request.method === "POST") {
    if (!verifyApiKey(request, env.API_KEY)) {
      return unauthorizedResponse();
    }

    let body: { from?: string; subject?: string; body?: string };
    try {
      body = await request.json() as { from?: string; subject?: string; body?: string };
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const simulatedEmail = {
      from: (body.from || "test@example.com").slice(0, 200),
      to: "inbox@moperator.ai",
      subject: (body.subject || "Test email").slice(0, 500),
      textBody: (body.body || "").slice(0, 10000),
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
}

// ================== TENANT-SCOPED DATA ACCESS ==================

async function getTenantAgents(kv: KVNamespace, tenantId: string): Promise<Agent[]> {
  const prefix = tenantKey(tenantId, "agent") + ":";
  const list = await kv.list({ prefix });
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

async function saveTenantEmailRecord(
  kv: KVNamespace,
  tenantId: string,
  email: any,
  decision: any,
  result: any,
  duration: number
): Promise<string> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    email,
    routingDecision: decision,
    dispatchResult: result,
    agentId: decision.agentId,
    processedAt: new Date().toISOString(),
    processingTimeMs: duration,
  };

  const key = tenantKey(tenantId, "email", id);
  await kv.put(key, JSON.stringify(record));

  // Update index
  const indexKey = tenantKey(tenantId, "email:index");
  const indexData = await kv.get(indexKey);
  const index: string[] = indexData ? JSON.parse(indexData) : [];
  index.unshift(id);
  if (index.length > 1000) index.pop();
  await kv.put(indexKey, JSON.stringify(index));

  return id;
}

async function updateEmailDispatchResult(
  kv: KVNamespace,
  tenantId: string,
  emailId: string,
  result: any,
  totalDuration: number
): Promise<void> {
  const key = tenantKey(tenantId, "email", emailId);
  const data = await kv.get(key);
  if (data) {
    const record = JSON.parse(data);
    record.dispatchResult = result;
    record.processingTimeMs = totalDuration;
    await kv.put(key, JSON.stringify(record));
  }
}

// Check if webhook URL is valid (not a placeholder)
function isValidWebhookUrl(url: string): boolean {
  if (!url) return false;
  // Skip placeholder URLs
  if (url.includes("your-webhook") || url.includes("example.com") || url.includes("placeholder")) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

async function getTenantEmails(
  kv: KVNamespace,
  tenantId: string,
  limit: number,
  offset: number
): Promise<{ emails: any[]; total: number }> {
  const indexKey = tenantKey(tenantId, "email:index");
  const indexData = await kv.get(indexKey);
  const index: string[] = indexData ? JSON.parse(indexData) : [];

  const total = index.length;
  const ids = index.slice(offset, offset + limit);

  const emails: any[] = [];
  for (const id of ids) {
    const data = await kv.get(tenantKey(tenantId, "email", id));
    if (data) {
      emails.push(JSON.parse(data));
    }
  }

  return { emails, total };
}

async function getTenantEmailRecord(
  kv: KVNamespace,
  tenantId: string,
  emailId: string
): Promise<any | null> {
  const data = await kv.get(tenantKey(tenantId, "email", emailId));
  return data ? JSON.parse(data) : null;
}

async function searchTenantEmails(
  kv: KVNamespace,
  tenantId: string,
  query: { from?: string; subject?: string; agentId?: string }
): Promise<any[]> {
  const { emails } = await getTenantEmails(kv, tenantId, 100, 0);

  return emails.filter((record) => {
    if (query.from && !record.email.from.toLowerCase().includes(query.from.toLowerCase())) {
      return false;
    }
    if (query.subject && !record.email.subject.toLowerCase().includes(query.subject.toLowerCase())) {
      return false;
    }
    if (query.agentId && record.agentId !== query.agentId) {
      return false;
    }
    return true;
  });
}

async function getTenantEmailStats(
  kv: KVNamespace,
  tenantId: string
): Promise<{ total: number; successful: number; failed: number; avgProcessingTimeMs: number }> {
  const { emails } = await getTenantEmails(kv, tenantId, 100, 0);

  const successful = emails.filter((e) => e.dispatchResult.success).length;
  const failed = emails.filter((e) => !e.dispatchResult.success).length;
  const avgProcessingTimeMs =
    emails.length > 0
      ? Math.round(emails.reduce((sum, e) => sum + e.processingTimeMs, 0) / emails.length)
      : 0;

  return { total: emails.length, successful, failed, avgProcessingTimeMs };
}

// Legacy: Get all active agents (not tenant-scoped)
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

// Create compact email summary for API responses (avoids ChatGPT response size limits)
function compactEmailSummary(record: any): any {
  return {
    id: record.id,
    from: record.email?.from || "",
    subject: record.email?.subject || "",
    preview: (record.email?.textBody || "").slice(0, 200).replace(/\s+/g, " ").trim(),
    receivedAt: record.email?.receivedAt || record.processedAt,
    agentId: record.agentId,
    success: record.dispatchResult?.success ?? true,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
