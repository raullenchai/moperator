// A2A (Agent-to-Agent) Protocol Implementation
// For Gemini and other A2A-compatible agents
// Spec: https://google.github.io/A2A/

import type { Tenant } from "../tenant";
import { tenantKey } from "../tenant";
import type { EmailRecord, Agent } from "../types";

// ==================== A2A Types ====================

interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: AgentCapability[];
  authentication: {
    type: "bearer" | "api_key" | "none";
    instructions?: string;
  };
}

interface AgentCapability {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

interface A2ATask {
  id: string;
  capability: string;
  input: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed";
  output?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

interface A2ATaskRequest {
  capability: string;
  input: Record<string, unknown>;
}

interface A2ATaskResponse {
  task: A2ATask;
}

// ==================== Agent Card ====================

export function getAgentCard(baseUrl: string): AgentCard {
  return {
    name: "Moperator Email Agent",
    description: "Email for AI — the inbox for your AI agents. Query emails, search by sender or subject, and manage routing agents. Built for LLMs and non-human intelligence.",
    url: baseUrl,
    version: "1.0.0",
    capabilities: [
      {
        name: "list_emails",
        description: "List recent emails with optional pagination",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max emails to return (default: 20)" },
            offset: { type: "number", description: "Pagination offset" },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            emails: { type: "array", items: { type: "object" } },
            total: { type: "number" },
          },
        },
      },
      {
        name: "get_email",
        description: "Get a specific email by ID",
        inputSchema: {
          type: "object",
          properties: {
            email_id: { type: "string", description: "Email ID" },
          },
          required: ["email_id"],
        },
        outputSchema: {
          type: "object",
          properties: {
            email: { type: "object" },
          },
        },
      },
      {
        name: "search_emails",
        description: "Search emails by sender, subject, or routing agent",
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: "Sender email (partial match)" },
            subject: { type: "string", description: "Subject line (partial match)" },
            agent_id: { type: "string", description: "Routing agent ID" },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            emails: { type: "array", items: { type: "object" } },
            count: { type: "number" },
          },
        },
      },
      {
        name: "list_agents",
        description: "List all registered email routing agents",
        inputSchema: {
          type: "object",
          properties: {},
        },
        outputSchema: {
          type: "object",
          properties: {
            agents: { type: "array", items: { type: "object" } },
          },
        },
      },
      {
        name: "get_stats",
        description: "Get email processing statistics",
        inputSchema: {
          type: "object",
          properties: {},
        },
        outputSchema: {
          type: "object",
          properties: {
            total: { type: "number" },
            successful: { type: "number" },
            failed: { type: "number" },
            avgProcessingTimeMs: { type: "number" },
          },
        },
      },
    ],
    authentication: {
      type: "bearer",
      instructions: "Include your Moperator API key in the Authorization header: Bearer mop_xxx",
    },
  };
}

// ==================== Task Execution ====================

export async function executeTask(
  taskRequest: A2ATaskRequest,
  tenant: Tenant,
  kv: { agents: KVNamespace; emails: KVNamespace }
): Promise<A2ATask> {
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const task: A2ATask = {
    id: taskId,
    capability: taskRequest.capability,
    input: taskRequest.input,
    status: "running",
    createdAt: now,
  };

  try {
    const result = await executeCapability(
      taskRequest.capability,
      taskRequest.input,
      tenant,
      kv
    );

    task.status = "completed";
    task.output = result;
    task.completedAt = new Date().toISOString();
  } catch (err) {
    task.status = "failed";
    task.error = err instanceof Error ? err.message : "Unknown error";
    task.completedAt = new Date().toISOString();
  }

  return task;
}

async function executeCapability(
  capability: string,
  input: Record<string, unknown>,
  tenant: Tenant,
  kv: { agents: KVNamespace; emails: KVNamespace }
): Promise<Record<string, unknown>> {
  switch (capability) {
    case "list_emails": {
      const limit = Math.min(Number(input.limit) || 20, 100);
      const offset = Number(input.offset) || 0;
      return await getEmails(kv.emails, tenant.id, limit, offset);
    }

    case "get_email": {
      const emailId = String(input.email_id);
      if (!emailId) throw new Error("email_id is required");
      const email = await getEmail(kv.emails, tenant.id, emailId);
      if (!email) throw new Error("Email not found");
      return { email };
    }

    case "search_emails": {
      const emails = await searchEmails(kv.emails, tenant.id, {
        from: input.from as string | undefined,
        subject: input.subject as string | undefined,
        agentId: input.agent_id as string | undefined,
      });
      return { emails, count: emails.length };
    }

    case "list_agents": {
      const agents = await getAgents(kv.agents, tenant.id);
      return { agents };
    }

    case "get_stats": {
      return await getStats(kv.emails, tenant.id);
    }

    default:
      throw new Error(`Unknown capability: ${capability}`);
  }
}

// ==================== Data Access (Tenant-Scoped) ====================

async function getEmails(
  kv: KVNamespace,
  tenantId: string,
  limit: number,
  offset: number
): Promise<{ emails: EmailRecord[]; total: number }> {
  const indexKey = tenantKey(tenantId, "email:index");
  const indexData = await kv.get(indexKey);
  const index: string[] = indexData ? JSON.parse(indexData) : [];

  const total = index.length;
  const ids = index.slice(offset, offset + limit);

  const emails: EmailRecord[] = [];
  for (const id of ids) {
    const data = await kv.get(tenantKey(tenantId, "email", id));
    if (data) {
      emails.push(JSON.parse(data));
    }
  }

  return { emails, total };
}

async function getEmail(
  kv: KVNamespace,
  tenantId: string,
  emailId: string
): Promise<EmailRecord | null> {
  const data = await kv.get(tenantKey(tenantId, "email", emailId));
  return data ? JSON.parse(data) : null;
}

async function searchEmails(
  kv: KVNamespace,
  tenantId: string,
  query: { from?: string; subject?: string; agentId?: string }
): Promise<EmailRecord[]> {
  const { emails } = await getEmails(kv, tenantId, 100, 0);

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

async function getAgents(kv: KVNamespace, tenantId: string): Promise<Agent[]> {
  const list = await kv.list({ prefix: tenantKey(tenantId, "agent") + ":" });
  const agents: Agent[] = [];

  for (const key of list.keys) {
    const data = await kv.get(key.name);
    if (data) {
      agents.push(JSON.parse(data));
    }
  }

  return agents;
}

async function getStats(
  kv: KVNamespace,
  tenantId: string
): Promise<{
  total: number;
  successful: number;
  failed: number;
  avgProcessingTimeMs: number;
}> {
  const { emails } = await getEmails(kv, tenantId, 100, 0);

  const successful = emails.filter((e) => e.dispatchResult.success).length;
  const failed = emails.filter((e) => !e.dispatchResult.success).length;
  const avgProcessingTimeMs =
    emails.length > 0
      ? Math.round(emails.reduce((sum, e) => sum + e.processingTimeMs, 0) / emails.length)
      : 0;

  return {
    total: emails.length,
    successful,
    failed,
    avgProcessingTimeMs,
  };
}

// ==================== HTTP Handlers ====================

export function handleAgentCardRequest(request: Request): Response {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  return new Response(JSON.stringify(getAgentCard(baseUrl), null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function handleA2ATaskRequest(
  request: Request,
  tenant: Tenant,
  kv: { agents: KVNamespace; emails: KVNamespace }
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed. Use POST to create tasks." }),
      { status: 405, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const body = (await request.json()) as A2ATaskRequest;

    if (!body.capability) {
      return new Response(
        JSON.stringify({ error: "Missing required field: capability" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const task = await executeTask(body, tenant, kv);

    return new Response(JSON.stringify({ task }, null, 2), {
      status: task.status === "completed" ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Failed to process task",
        details: err instanceof Error ? err.message : undefined,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

// ==================== Capability Discovery ====================

export function handleCapabilitiesRequest(): Response {
  const capabilities = getAgentCard("").capabilities;

  return new Response(JSON.stringify({ capabilities }, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
