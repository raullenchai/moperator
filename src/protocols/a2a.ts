/**
 * A2A (Agent-to-Agent) Protocol Implementation
 * For Gemini and other A2A-compatible agents
 * Spec: https://google.github.io/A2A/
 *
 * Endpoints:
 * - GET  /.well-known/agent.json - Agent Card (discovery)
 * - GET  /a2a/capabilities - List capabilities
 * - POST /a2a/tasks - Execute a task
 */

import type { Tenant } from "../tenant";
import { tenantKey } from "../tenant";
import type { EmailRecord, Agent } from "../types";

// ==================== Types ====================

export interface AgentCard {
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

export interface AgentCapability {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  capability: string;
  input: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed";
  output?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface A2ATaskRequest {
  capability: string;
  input: Record<string, unknown>;
}

// ==================== Agent Card ====================

/**
 * Agent Card for A2A discovery - describes this agent's capabilities
 */
export function getAgentCard(baseUrl: string): AgentCard {
  return {
    name: "Moperator Email Agent",
    description:
      "Email for AI — the inbox for your AI agents. Query emails, search by sender or subject, and get email statistics. Built for LLMs and autonomous systems.",
    url: baseUrl,
    version: "1.0.0",
    capabilities: CAPABILITIES,
    authentication: {
      type: "bearer",
      instructions: "Include your Moperator API key in the Authorization header: Bearer mop_xxx",
    },
  };
}

/**
 * Available capabilities - used in both Agent Card and capabilities endpoint
 */
export const CAPABILITIES: AgentCapability[] = [
  {
    name: "check_inbox",
    description: "Check your email inbox. Returns a list of recent emails with sender, subject, and preview.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max emails to return (default: 20, max: 100)" },
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
    name: "read_email",
    description: "Read the full content of a specific email by ID.",
    inputSchema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "Email ID to read" },
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
    description: "Search emails by sender or subject. Uses partial matching.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Sender email (partial match)" },
        subject: { type: "string", description: "Subject line (partial match)" },
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
    name: "email_stats",
    description: "Get email processing statistics - total count, success rate, etc.",
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
];

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
    task.output = await executeCapability(taskRequest.capability, taskRequest.input, tenant, kv);
    task.status = "completed";
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
    case "check_inbox": {
      const limit = Math.min(Number(input.limit) || 20, 100);
      const { emails, total } = await getEmails(kv.emails, tenant.id, limit, 0);
      return {
        emails: emails.map((e) => ({
          id: e.id,
          from: e.email.from,
          subject: e.email.subject,
          preview: e.email.textBody?.slice(0, 200) || "",
          receivedAt: e.email.receivedAt,
        })),
        total,
      };
    }

    case "read_email": {
      const emailId = String(input.email_id || "");
      if (!emailId) throw new Error("email_id is required");
      const record = await getEmail(kv.emails, tenant.id, emailId);
      if (!record) throw new Error("Email not found");
      return {
        email: {
          id: record.id,
          from: record.email.from,
          to: record.email.to,
          subject: record.email.subject,
          body: record.email.textBody,
          receivedAt: record.email.receivedAt,
        },
      };
    }

    case "search_emails": {
      const emails = await searchEmails(kv.emails, tenant.id, {
        from: input.from as string | undefined,
        subject: input.subject as string | undefined,
      });
      return {
        emails: emails.map((e) => ({
          id: e.id,
          from: e.email.from,
          subject: e.email.subject,
          preview: e.email.textBody?.slice(0, 200) || "",
          receivedAt: e.email.receivedAt,
        })),
        count: emails.length,
      };
    }

    case "email_stats": {
      return await getStats(kv.emails, tenant.id);
    }

    default:
      throw new Error(`Unknown capability: ${capability}`);
  }
}

// ==================== Data Access ====================

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
  for (const emailId of ids) {
    const data = await kv.get(tenantKey(tenantId, "email", emailId));
    if (data) emails.push(JSON.parse(data));
  }

  return { emails, total };
}

async function getEmail(kv: KVNamespace, tenantId: string, emailId: string): Promise<EmailRecord | null> {
  const data = await kv.get(tenantKey(tenantId, "email", emailId));
  return data ? JSON.parse(data) : null;
}

async function searchEmails(
  kv: KVNamespace,
  tenantId: string,
  query: { from?: string; subject?: string }
): Promise<EmailRecord[]> {
  const { emails } = await getEmails(kv, tenantId, 100, 0);

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

async function getStats(
  kv: KVNamespace,
  tenantId: string
): Promise<{ total: number; successful: number; failed: number; avgProcessingTimeMs: number }> {
  const { emails } = await getEmails(kv, tenantId, 100, 0);

  const successful = emails.filter((e) => e.dispatchResult.success).length;
  const failed = emails.filter((e) => !e.dispatchResult.success).length;
  const avgProcessingTimeMs =
    emails.length > 0 ? Math.round(emails.reduce((sum, e) => sum + e.processingTimeMs, 0) / emails.length) : 0;

  return { total: emails.length, successful, failed, avgProcessingTimeMs };
}

// ==================== HTTP Handlers ====================

export function handleAgentCardRequest(request: Request): Response {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  return new Response(JSON.stringify(getAgentCard(baseUrl), null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export function handleCapabilitiesRequest(): Response {
  return new Response(JSON.stringify({ capabilities: CAPABILITIES }, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export async function handleA2ATaskRequest(
  request: Request,
  tenant: Tenant,
  kv: { agents: KVNamespace; emails: KVNamespace }
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed. Use POST to create tasks." }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await request.json()) as A2ATaskRequest;

    if (!body.capability) {
      return new Response(JSON.stringify({ error: "Missing required field: capability" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const task = await executeTask(body, tenant, kv);

    return new Response(JSON.stringify({ task }, null, 2), {
      status: task.status === "completed" ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Failed to process task", details: err instanceof Error ? err.message : undefined }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}
