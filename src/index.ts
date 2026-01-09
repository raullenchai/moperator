import type { Env, Agent, Label, DispatchResult } from "./types";
import { parseEmail } from "./email-parser";
import { labelEmail } from "./labeler";
import { dispatchToSubscribedAgents, isValidWebhookUrl } from "./dispatcher";
import { saveEmailRecord, getRecentEmails, getEmailRecord, getEmailStats, searchEmails } from "./email-history";
import { addToRetryQueue, processRetryQueue, getQueueStats, getRetryItems, getDeadLetterItems } from "./retry-queue";
import { checkRateLimit, getClientId, rateLimitResponse, checkTenantRateLimit, DEFAULT_CONFIG, STRICT_CONFIG } from "./rate-limiter";
import { verifyApiKey, unauthorizedResponse } from "./auth";
import { checkAllAgentsHealth, checkAgentHealth, getHealthSummary, reEnableAgent } from "./health-check";
import type { AgentWithHealth } from "./health-check";

// Labels
import {
  getTenantLabels,
  getTenantLabel,
  createTenantLabel,
  updateTenantLabel,
  deleteTenantLabel,
  validateLabelId,
  validateAssignedLabels,
  initializeTenantLabels,
} from "./labels";

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
  signupTenant,
  loginTenant,
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
    console.log(`[TENANT] Processing for tenant: ${tenant.id} (${tenant.name})`);

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

    // Get tenant's labels for classification
    const labels = await getTenantLabels(env.AGENT_REGISTRY, tenant.id);
    console.log(`[LABELS] Tenant has ${labels.length} labels: ${labels.map(l => l.id).join(", ")}`);

    // Label email using Claude
    console.log("[LABELER] Calling Claude for labeling decision...");
    const labelingDecision = await labelEmail(email, labels, env.ANTHROPIC_API_KEY);
    const assignedLabels = validateAssignedLabels(labelingDecision.labels, labels);
    console.log(`[LABELER] Labels: ${assignedLabels.join(", ")}`);
    console.log(`[LABELER] Reason: ${labelingDecision.reason}`);

    const labelingDuration = Date.now() - startTime;
    console.log(`[LABELER] Labeling completed in ${labelingDuration}ms`);

    // Get tenant's agents
    const agents = await getTenantAgents(env.AGENT_REGISTRY, tenant.id);
    console.log(`[AGENTS] Found ${agents.length} agents`);

    // Save email to KV immediately (so MCP/API users can access right away)
    const emailId = await saveTenantEmailRecord(
      env.EMAIL_HISTORY,
      tenant.id,
      email,
      assignedLabels,
      labelingDecision,
      [], // Dispatch results will be updated after dispatch
      labelingDuration
    );
    console.log(`[STORE] Email saved: ${emailId}`);

    // Update usage stats
    await incrementUsage(env.TENANTS, tenant.id, "emailsToday");
    await incrementUsage(env.TENANTS, tenant.id, "emailsTotal");

    // Dispatch to subscribed agents
    const dispatchResults = await dispatchToSubscribedAgents(
      email,
      assignedLabels,
      agents,
      labelingDecision.reason,
      env.WEBHOOK_SIGNING_KEY
    );

    const totalDuration = Date.now() - startTime;

    // Update stored record with dispatch results
    if (dispatchResults.length > 0) {
      await updateEmailDispatchResults(env.EMAIL_HISTORY, tenant.id, emailId, dispatchResults, totalDuration);
    }

    // Log results
    const successful = dispatchResults.filter(r => r.success).length;
    const failed = dispatchResults.filter(r => !r.success).length;
    console.log(`[DISPATCH] ${dispatchResults.length} agents notified (${successful} success, ${failed} failed)`);

    // Add failed dispatches to retry queue
    for (const result of dispatchResults.filter(r => !r.success)) {
      const agent = agents.find(a => a.id === result.agentId);
      if (agent?.webhookUrl) {
        await addToRetryQueue(
          env.RETRY_QUEUE,
          email,
          agent,
          assignedLabels,
          result.matchedLabel,
          labelingDecision.reason,
          result.error || `Status: ${result.statusCode}`,
          tenant.id
        );
      }
    }

    console.log(`[COMPLETE] Email processed in ${totalDuration}ms`);
    console.log("=".repeat(60));
  },

  // Scheduled handler for retry processing and health checks
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    console.log("[CRON] Starting scheduled tasks...");

    // Run retry queue processing
    const retryStats = await processRetryQueue(env.RETRY_QUEUE, env.WEBHOOK_SIGNING_KEY);
    console.log(`[CRON] Retry: ${retryStats.processed} processed, ${retryStats.succeeded} succeeded`);

    // Run health checks on agents
    const healthStats = await checkAllAgentsHealth(env.AGENT_REGISTRY);
    console.log(`[CRON] Health: ${healthStats.checked} checked, ${healthStats.healthy} healthy`);

    // Reset daily usage at midnight
    const now = new Date();
    if (now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
      const resetCount = await resetDailyUsage(env.TENANTS);
      console.log(`[CRON] Reset daily usage for ${resetCount} tenants`);
    }
  },

  // HTTP API
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
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // ================== PUBLIC ENDPOINTS ==================

    if (url.pathname === "/health") {
      return json({ status: "ok", service: "moperator", version: "3.0.0" });
    }

    if (url.pathname === "/openapi.json" || url.pathname === "/openapi.yaml") {
      return handleOpenAPIRequest(request);
    }

    if (url.pathname === "/privacy") {
      return privacyPage();
    }

    if (url.pathname === "/.well-known/agent.json") {
      return handleAgentCardRequest(request);
    }

    if (url.pathname === "/a2a/capabilities" && request.method === "GET") {
      return handleCapabilitiesRequest();
    }

    // ================== AUTH ENDPOINTS (Public) ==================

    if (url.pathname === "/auth/signup" && request.method === "POST") {
      try {
        const body = await request.json() as { email?: string; password?: string; name?: string };

        if (!body.email || !body.password) {
          return json({ error: "Email and password are required" }, 400);
        }

        if (body.password.length < 6) {
          return json({ error: "Password must be at least 6 characters" }, 400);
        }

        const result = await signupTenant(env.TENANTS, {
          email: body.email,
          password: body.password,
          name: body.name,
        });

        return json({
          success: true,
          tenant: {
            id: result.tenant.id,
            name: result.tenant.name,
            email: result.tenant.email,
            inboxEmail: result.tenant.email,
          },
          apiKey: result.apiKey,
        }, 201);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Signup failed";
        return json({ error: message }, 400);
      }
    }

    if (url.pathname === "/auth/login" && request.method === "POST") {
      try {
        const body = await request.json() as { email?: string; password?: string };

        if (!body.email || !body.password) {
          return json({ error: "Email and password are required" }, 400);
        }

        const result = await loginTenant(env.TENANTS, body.email, body.password);

        if (!result) {
          return json({ error: "Invalid email or password" }, 401);
        }

        return json({
          success: true,
          tenant: {
            id: result.tenant.id,
            name: result.tenant.name,
            email: result.tenant.email,
            inboxEmail: result.tenant.email,
          },
          apiKey: result.apiKey,
        });
      } catch (err) {
        return json({ error: "Login failed" }, 500);
      }
    }

    // ================== ADMIN ENDPOINTS ==================

    if (url.pathname.startsWith("/admin/")) {
      const adminSecret = request.headers.get("X-Admin-Secret");
      if (!adminSecret || adminSecret !== env.ADMIN_SECRET) {
        return json({ error: "Admin access required" }, 403);
      }

      const rateLimitKv = env.RATE_LIMIT || env.AGENT_REGISTRY;
      const rateLimit = await checkRateLimit(rateLimitKv, `admin:${clientId}`, STRICT_CONFIG);
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.resetAt);
      }

      return handleAdminEndpoints(request, env, url);
    }

    // ================== LEGACY ENDPOINTS ==================

    if (url.pathname === "/agents" || url.pathname.startsWith("/agents/") ||
        url.pathname === "/health/agents" || url.pathname.startsWith("/health/") ||
        url.pathname === "/emails" || url.pathname.startsWith("/emails/") ||
        url.pathname === "/retry" || url.pathname.startsWith("/retry/") ||
        url.pathname === "/test-route") {

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

    const authHeader = request.headers.get("Authorization");
    const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!apiKey) {
      return json({ error: "Authorization required. Use Bearer token with your API key." }, 401);
    }

    const tenant = await authenticateByApiKey(env.TENANTS, apiKey);
    if (!tenant) {
      return json({ error: "Invalid API key" }, 401);
    }

    const rateLimitKv = env.RATE_LIMIT || env.AGENT_REGISTRY;
    const tenantRateLimit = await checkTenantRateLimit(rateLimitKv, tenant);
    if (!tenantRateLimit.allowed) {
      return rateLimitResponse(tenantRateLimit.resetAt);
    }

    // Protocol endpoints
    if (url.pathname === "/mcp" && request.method === "POST") {
      if (!tenant.settings.enabledProtocols.includes("mcp")) {
        return json({ error: "MCP protocol not enabled for this tenant" }, 403);
      }
      return handleMCPHttp(request, tenant, {
        agents: env.AGENT_REGISTRY,
        emails: env.EMAIL_HISTORY,
      });
    }

    if (url.pathname === "/a2a/tasks" && request.method === "POST") {
      if (!tenant.settings.enabledProtocols.includes("a2a")) {
        return json({ error: "A2A protocol not enabled for this tenant" }, 403);
      }
      return handleA2ATaskRequest(request, tenant, {
        agents: env.AGENT_REGISTRY,
        emails: env.EMAIL_HISTORY,
      });
    }

    // Tenant API endpoints
    return handleTenantEndpoints(request, env, url, tenant);
  },
};

// ================== TENANT ENDPOINTS ==================

async function handleTenantEndpoints(
  request: Request,
  env: Env,
  url: URL,
  tenant: Tenant
): Promise<Response> {
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

  // ================== LABEL ENDPOINTS ==================

  // List labels
  if (url.pathname === "/api/v1/labels" && request.method === "GET") {
    const labels = await getTenantLabels(env.AGENT_REGISTRY, tenant.id);
    return json({ labels });
  }

  // Create label
  if (url.pathname === "/api/v1/labels" && request.method === "POST") {
    let body: Partial<Label>;
    try {
      body = await request.json() as Partial<Label>;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.id || !body.name || !body.description) {
      return json({ error: "Missing required fields: id, name, description" }, 400);
    }

    // Validate label ID: lowercase letters only (a-z), no numbers, no special chars
    if (!/^[a-z]+$/.test(body.id)) {
      return json({ error: "Label ID must contain only lowercase letters (a-z)" }, 400);
    }

    try {
      const label = await createTenantLabel(env.AGENT_REGISTRY, tenant.id, body as Label);
      return json({ label }, 201);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Failed to create label" }, 400);
    }
  }

  // Update label
  if (url.pathname.match(/^\/api\/v1\/labels\/[a-z]+$/) && request.method === "PUT") {
    const labelId = url.pathname.split("/")[4];
    let body: Partial<Omit<Label, "id">>;
    try {
      body = await request.json() as Partial<Omit<Label, "id">>;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    try {
      const label = await updateTenantLabel(env.AGENT_REGISTRY, tenant.id, labelId, body);
      if (!label) {
        return json({ error: "Label not found" }, 404);
      }
      return json({ label });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Failed to update label" }, 400);
    }
  }

  // Delete label
  if (url.pathname.match(/^\/api\/v1\/labels\/[a-z]+$/) && request.method === "DELETE") {
    const labelId = url.pathname.split("/")[4];
    try {
      const deleted = await deleteTenantLabel(env.AGENT_REGISTRY, tenant.id, labelId);
      if (!deleted) {
        return json({ error: "Label not found" }, 404);
      }
      return json({ deleted: labelId });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Failed to delete label" }, 400);
    }
  }

  // ================== AGENT ENDPOINTS ==================

  // List agents
  if (url.pathname === "/api/v1/agents" && request.method === "GET") {
    const agents = await getTenantAgents(env.AGENT_REGISTRY, tenant.id);
    return json({ agents });
  }

  // Register agent
  if (url.pathname === "/api/v1/agents" && request.method === "POST") {
    if (tenant.usage.agentCount >= tenant.settings.maxAgents) {
      return json({ error: `Maximum agents (${tenant.settings.maxAgents}) reached` }, 400);
    }

    let body: Partial<Agent>;
    try {
      body = await request.json() as Partial<Agent>;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.id || !body.name || !body.description) {
      return json({ error: "Missing required fields: id, name, description" }, 400);
    }

    if (!/^[a-z]+$/.test(body.id)) {
      return json({ error: "Agent ID must contain only lowercase letters (a-z)" }, 400);
    }

    if (!body.labels || !Array.isArray(body.labels) || body.labels.length === 0) {
      return json({ error: "Agent must subscribe to at least one label" }, 400);
    }

    // Validate labels exist
    const tenantLabels = await getTenantLabels(env.AGENT_REGISTRY, tenant.id);
    const validLabelIds = new Set(tenantLabels.map(l => l.id));
    const invalidLabels = body.labels.filter(l => !validLabelIds.has(l));
    if (invalidLabels.length > 0) {
      return json({ error: `Invalid labels: ${invalidLabels.join(", ")}` }, 400);
    }

    if (body.webhookUrl) {
      try {
        new URL(body.webhookUrl);
      } catch {
        return json({ error: "Invalid webhookUrl format" }, 400);
      }
    }

    const agent: Agent = {
      id: body.id,
      name: body.name.slice(0, 100),
      description: body.description.slice(0, 500),
      webhookUrl: body.webhookUrl,
      labels: body.labels,
      active: body.active ?? true,
    };

    await env.AGENT_REGISTRY.put(tenantKey(tenant.id, "agent", agent.id), JSON.stringify(agent));
    await incrementUsage(env.TENANTS, tenant.id, "agentCount");

    return json({ agent }, 201);
  }

  // Update agent
  if (url.pathname.match(/^\/api\/v1\/agents\/[a-z]+$/) && request.method === "PUT") {
    const agentId = url.pathname.split("/")[4];
    const key = tenantKey(tenant.id, "agent", agentId);
    const existing = await env.AGENT_REGISTRY.get(key);
    if (!existing) {
      return json({ error: "Agent not found" }, 404);
    }

    let body: Partial<Agent>;
    try {
      body = await request.json() as Partial<Agent>;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const agent = JSON.parse(existing) as Agent;

    if (body.name) agent.name = body.name.slice(0, 100);
    if (body.description) agent.description = body.description.slice(0, 500);
    if (body.webhookUrl !== undefined) agent.webhookUrl = body.webhookUrl;
    if (body.active !== undefined) agent.active = body.active;

    if (body.labels) {
      const tenantLabels = await getTenantLabels(env.AGENT_REGISTRY, tenant.id);
      const validLabelIds = new Set(tenantLabels.map(l => l.id));
      const invalidLabels = body.labels.filter(l => !validLabelIds.has(l));
      if (invalidLabels.length > 0) {
        return json({ error: `Invalid labels: ${invalidLabels.join(", ")}` }, 400);
      }
      agent.labels = body.labels;
    }

    await env.AGENT_REGISTRY.put(key, JSON.stringify(agent));
    return json({ agent });
  }

  // Delete agent
  if (url.pathname.match(/^\/api\/v1\/agents\/[a-z]+$/) && request.method === "DELETE") {
    const agentId = url.pathname.split("/")[4];
    if (!agentId || !/^[a-z]+$/.test(agentId)) {
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

  // ================== EMAIL ENDPOINTS ==================

  // List emails (with optional label filter)
  if (url.pathname === "/api/v1/emails" && request.method === "GET") {
    const limitParam = url.searchParams.get("limit") || "10";
    const offsetParam = url.searchParams.get("offset") || "0";
    const labelsParam = url.searchParams.get("labels");

    const limit = Math.min(Math.max(1, parseInt(limitParam) || 10), 50);
    const offset = Math.max(0, parseInt(offsetParam) || 0);
    const labelFilter = labelsParam ? labelsParam.split(",").map(l => l.trim()) : undefined;

    const result = await getTenantEmails(env.EMAIL_HISTORY, tenant.id, limit, offset, labelFilter);
    const compactEmails = result.emails.map(compactEmailSummary);
    return json({ emails: compactEmails, total: result.total, limit, offset });
  }

  // Search emails
  if (url.pathname === "/api/v1/emails/search" && request.method === "GET") {
    const from = (url.searchParams.get("from") || "").slice(0, 200) || undefined;
    const subject = (url.searchParams.get("subject") || "").slice(0, 200) || undefined;
    const labelsParam = url.searchParams.get("labels");
    const labelFilter = labelsParam ? labelsParam.split(",").map(l => l.trim()) : undefined;

    const emails = await searchTenantEmails(env.EMAIL_HISTORY, tenant.id, { from, subject, labels: labelFilter });
    const compactEmails = emails.map(compactEmailSummary);
    return json({ emails: compactEmails, count: compactEmails.length });
  }

  // Get email by ID
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

  // Get email stats
  if (url.pathname === "/api/v1/emails/stats" && request.method === "GET") {
    const stats = await getTenantEmailStats(env.EMAIL_HISTORY, tenant.id);
    return json(stats);
  }

  return json({ error: "Not found" }, 404);
}

// ================== ADMIN ENDPOINTS ==================

async function handleAdminEndpoints(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/admin/tenants" && request.method === "GET") {
    const tenants = await listTenants(env.TENANTS);
    return json({ tenants: tenants.map(t => ({ ...t, apiKey: undefined })), count: tenants.length });
  }

  if (url.pathname === "/admin/tenants" && request.method === "POST") {
    try {
      const body = await request.json() as { id: string; name: string; email: string };
      if (!body.id || !body.name || !body.email) {
        return json({ error: "Missing required fields: id, name, email" }, 400);
      }
      const result = await createTenant(env.TENANTS, body);
      // Initialize default labels for new tenant
      await initializeTenantLabels(env.AGENT_REGISTRY, body.id);
      return json({ tenant: { ...result.tenant, apiKey: undefined }, apiKey: result.apiKey }, 201);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Failed to create tenant" }, 400);
    }
  }

  if (url.pathname.match(/^\/admin\/tenants\/[\w-]+$/) && request.method === "GET") {
    const tenantId = url.pathname.split("/")[3];
    const tenant = await getTenant(env.TENANTS, tenantId);
    if (!tenant) {
      return json({ error: "Tenant not found" }, 404);
    }
    return json({ tenant: { ...tenant, apiKey: undefined } });
  }

  if (url.pathname.match(/^\/admin\/tenants\/[\w-]+\/regenerate-key$/) && request.method === "POST") {
    const tenantId = url.pathname.split("/")[3];
    const result = await regenerateApiKey(env.TENANTS, tenantId);
    if (!result) {
      return json({ error: "Tenant not found" }, 404);
    }
    return json({ apiKey: result.apiKey });
  }

  if (url.pathname.match(/^\/admin\/tenants\/[\w-]+\/settings$/) && request.method === "PATCH") {
    const tenantId = url.pathname.split("/")[3];
    const settings = await request.json();
    const tenant = await updateTenantSettings(env.TENANTS, tenantId, settings as any);
    if (!tenant) {
      return json({ error: "Tenant not found" }, 404);
    }
    return json({ tenant: { ...tenant, apiKey: undefined } });
  }

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

// ================== LEGACY ENDPOINTS ==================

async function handleLegacyEndpoints(request: Request, env: Env, url: URL): Promise<Response> {
  // Agent endpoints
  if (url.pathname === "/agents" && request.method === "GET") {
    const agents = await getActiveAgents(env.AGENT_REGISTRY);
    return json({ agents });
  }

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

    if (!body.id || !body.name || !body.description) {
      return json({ error: "Missing required fields: id, name, description" }, 400);
    }

    const agent: Agent = {
      id: body.id,
      name: body.name.slice(0, 100),
      description: body.description.slice(0, 500),
      webhookUrl: body.webhookUrl,
      labels: body.labels || ["catch-all"],
      active: body.active ?? true,
    };

    await env.AGENT_REGISTRY.put(`agent:${agent.id}`, JSON.stringify(agent));
    return json({ agent }, 201);
  }

  if (url.pathname.startsWith("/agents/") && url.pathname.endsWith("/enable") && request.method === "POST") {
    if (!verifyApiKey(request, env.API_KEY)) {
      return unauthorizedResponse();
    }
    const agentId = url.pathname.split("/")[2];
    const agent = await reEnableAgent(env.AGENT_REGISTRY, agentId);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }
    return json({ agent, message: "Agent re-enabled successfully" });
  }

  if (url.pathname.startsWith("/agents/") && request.method === "DELETE") {
    if (!verifyApiKey(request, env.API_KEY)) {
      return unauthorizedResponse();
    }
    const agentId = url.pathname.split("/")[2];
    await env.AGENT_REGISTRY.delete(`agent:${agentId}`);
    return json({ deleted: agentId });
  }

  // Health endpoints
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

  // Legacy email endpoints - deprecated, use /api/v1/emails with authentication
  if (url.pathname === "/emails/stats" || url.pathname === "/emails" ||
      url.pathname === "/emails/search" || url.pathname.match(/^\/emails\/[\w-]+$/)) {
    return json({
      error: "Email endpoints moved to /api/v1/emails",
      hint: "Use Bearer token authentication with your API key",
    }, 410);
  }

  // Retry endpoints
  if (url.pathname === "/retry/stats" && request.method === "GET") {
    const stats = await getQueueStats(env.RETRY_QUEUE);
    return json(stats);
  }

  if (url.pathname === "/retry/pending" && request.method === "GET") {
    const items = await getRetryItems(env.RETRY_QUEUE);
    return json({ items, count: items.length });
  }

  if (url.pathname === "/retry/dead" && request.method === "GET") {
    const items = await getDeadLetterItems(env.RETRY_QUEUE);
    return json({ items, count: items.length });
  }

  if (url.pathname === "/retry/process" && request.method === "POST") {
    if (!verifyApiKey(request, env.API_KEY)) {
      return unauthorizedResponse();
    }
    const stats = await processRetryQueue(env.RETRY_QUEUE, env.WEBHOOK_SIGNING_KEY);
    return json(stats);
  }

  // Test route
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
      from: body.from || "test@example.com",
      to: "inbox@moperator.ai",
      subject: body.subject || "Test email",
      textBody: body.body || "",
      attachments: [],
      receivedAt: new Date().toISOString(),
    };

    // Use default labels for testing
    const labels = [
      { id: "important", name: "Important", description: "Urgent emails" },
      { id: "catch-all", name: "Other", description: "Default category" },
    ];

    const decision = await labelEmail(simulatedEmail, labels, env.ANTHROPIC_API_KEY);

    return json({
      email: simulatedEmail,
      labeling: decision,
      availableLabels: labels.map(l => ({ id: l.id, name: l.name })),
    });
  }

  return json({ error: "Not found" }, 404);
}

// ================== DATA ACCESS HELPERS ==================

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
  labels: string[],
  labelingDecision: any,
  dispatchResults: DispatchResult[],
  duration: number
): Promise<string> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    email,
    labels,
    labelingDecision,
    dispatchResults,
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

  // Update label indexes
  for (const label of labels) {
    const labelIndexKey = tenantKey(tenantId, "label", label, "emails");
    const labelIndexData = await kv.get(labelIndexKey);
    const labelIndex: string[] = labelIndexData ? JSON.parse(labelIndexData) : [];
    labelIndex.unshift(id);
    if (labelIndex.length > 500) labelIndex.pop();
    await kv.put(labelIndexKey, JSON.stringify(labelIndex));
  }

  return id;
}

async function updateEmailDispatchResults(
  kv: KVNamespace,
  tenantId: string,
  emailId: string,
  results: DispatchResult[],
  totalDuration: number
): Promise<void> {
  const key = tenantKey(tenantId, "email", emailId);
  const data = await kv.get(key);
  if (data) {
    const record = JSON.parse(data);
    record.dispatchResults = results;
    record.processingTimeMs = totalDuration;
    await kv.put(key, JSON.stringify(record));
  }
}

async function getTenantEmails(
  kv: KVNamespace,
  tenantId: string,
  limit: number,
  offset: number,
  labelFilter?: string[]
): Promise<{ emails: any[]; total: number }> {
  // If filtering by label, use label index
  if (labelFilter && labelFilter.length > 0) {
    const emailIds = new Set<string>();

    for (const label of labelFilter) {
      const labelIndexKey = tenantKey(tenantId, "label", label, "emails");
      const labelIndexData = await kv.get(labelIndexKey);
      const labelIndex: string[] = labelIndexData ? JSON.parse(labelIndexData) : [];
      for (const id of labelIndex) {
        emailIds.add(id);
      }
    }

    const allIds = Array.from(emailIds);
    const total = allIds.length;
    const ids = allIds.slice(offset, offset + limit);

    const emails: any[] = [];
    for (const id of ids) {
      const data = await kv.get(tenantKey(tenantId, "email", id));
      if (data) {
        emails.push(JSON.parse(data));
      }
    }

    return { emails, total };
  }

  // Otherwise use main index
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

async function getTenantEmailRecord(kv: KVNamespace, tenantId: string, emailId: string): Promise<any | null> {
  const data = await kv.get(tenantKey(tenantId, "email", emailId));
  return data ? JSON.parse(data) : null;
}

async function searchTenantEmails(
  kv: KVNamespace,
  tenantId: string,
  query: { from?: string; subject?: string; labels?: string[] }
): Promise<any[]> {
  const { emails } = await getTenantEmails(kv, tenantId, 100, 0, query.labels);

  return emails.filter((record) => {
    if (query.from && !record.email.from.toLowerCase().includes(query.from.toLowerCase())) {
      return false;
    }
    if (query.subject && !record.email.subject.toLowerCase().includes(query.subject.toLowerCase())) {
      return false;
    }
    return true;
  });
}

async function getTenantEmailStats(
  kv: KVNamespace,
  tenantId: string
): Promise<{ total: number; byLabel: Record<string, number>; avgProcessingTimeMs: number }> {
  const { emails } = await getTenantEmails(kv, tenantId, 100, 0);

  const byLabel: Record<string, number> = {};
  let totalProcessingTime = 0;

  for (const email of emails) {
    totalProcessingTime += email.processingTimeMs || 0;
    for (const label of email.labels || []) {
      byLabel[label] = (byLabel[label] || 0) + 1;
    }
  }

  const avgProcessingTimeMs = emails.length > 0 ? Math.round(totalProcessingTime / emails.length) : 0;

  return { total: emails.length, byLabel, avgProcessingTimeMs };
}

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

function compactEmailSummary(record: any): any {
  return {
    id: record.id,
    from: record.email?.from || "",
    subject: record.email?.subject || "",
    preview: (record.email?.textBody || "").slice(0, 200).replace(/\s+/g, " ").trim(),
    labels: record.labels || [],
    receivedAt: record.email?.receivedAt || record.processedAt,
    success: record.dispatchResults?.every((r: any) => r.success) ?? true,
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

function privacyPage(): Response {
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
  <p>Moperator ("Email for AI") is an email infrastructure service for AI agents.</p>
  <h2>Data We Process</h2>
  <ul>
    <li><strong>Email Data:</strong> Emails sent to your Moperator address are labeled and routed to your configured agents.</li>
    <li><strong>API Usage:</strong> We log API requests for security and debugging.</li>
  </ul>
  <h2>Data Retention</h2>
  <p>Email records are retained for 30 days. You can delete your account and data at any time.</p>
  <h2>Third Parties</h2>
  <p>We use Cloudflare for hosting and Anthropic Claude for email labeling.</p>
</body>
</html>`, {
    status: 200,
    headers: { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" },
  });
}
