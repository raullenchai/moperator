/**
 * A2A (Agent-to-Agent) Protocol Implementation
 * For Gemini and other A2A-compatible agents
 * Spec: https://google.github.io/A2A/
 */

import type { Tenant } from "../tenant";
import { tenantKey } from "../tenant";
import type { EmailRecord } from "../types";
import { getTenantLabels } from "../labels";

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

export function getAgentCard(baseUrl: string): AgentCard {
  return {
    name: "Moperator Email Agent",
    description:
      "Email for AI — the inbox for your AI agents. Query emails by label, search by sender or subject, and get email statistics. Built for LLMs and autonomous systems.",
    url: baseUrl,
    version: "2.0.0",
    capabilities: CAPABILITIES,
    authentication: {
      type: "bearer",
      instructions: "Include your Moperator API key in the Authorization header: Bearer mop_xxx",
    },
  };
}

export const CAPABILITIES: AgentCapability[] = [
  {
    name: "check_inbox",
    description: "Check your email inbox. Returns a list of recent emails with sender, subject, labels, and preview.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max emails to return (default: 20, max: 100)" },
        labels: { type: "array", items: { type: "string" }, description: "Filter by label(s)" },
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
    description: "Search emails by sender, subject, or label. Uses partial matching.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Sender email (partial match)" },
        subject: { type: "string", description: "Subject line (partial match)" },
        labels: { type: "array", items: { type: "string" }, description: "Filter by label(s)" },
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
    name: "list_labels",
    description: "List all available labels for organizing emails.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    outputSchema: {
      type: "object",
      properties: {
        labels: { type: "array", items: { type: "object" } },
      },
    },
  },
  {
    name: "email_stats",
    description: "Get email processing statistics - total count, emails per label, etc.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "number" },
        byLabel: { type: "object" },
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
      const labelFilter = Array.isArray(input.labels) ? input.labels as string[] : undefined;
      const { emails, total } = await getEmails(kv.emails, tenant.id, limit, 0, labelFilter);
      return {
        emails: emails.map((e) => ({
          id: e.id,
          from: e.email.from,
          subject: e.email.subject,
          labels: (e as any).labels || [],
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
          labels: (record as any).labels || [],
          body: record.email.textBody,
          receivedAt: record.email.receivedAt,
        },
      };
    }

    case "search_emails": {
      const labelFilter = Array.isArray(input.labels) ? input.labels as string[] : undefined;
      const emails = await searchEmails(kv.emails, tenant.id, {
        from: input.from as string | undefined,
        subject: input.subject as string | undefined,
        labels: labelFilter,
      });
      return {
        emails: emails.map((e) => ({
          id: e.id,
          from: e.email.from,
          subject: e.email.subject,
          labels: (e as any).labels || [],
          preview: e.email.textBody?.slice(0, 200) || "",
          receivedAt: e.email.receivedAt,
        })),
        count: emails.length,
      };
    }

    case "list_labels": {
      const labels = await getTenantLabels(kv.agents, tenant.id);
      return { labels };
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
  offset: number,
  labelFilter?: string[]
): Promise<{ emails: EmailRecord[]; total: number }> {
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

    const emails: EmailRecord[] = [];
    for (const emailId of ids) {
      const data = await kv.get(tenantKey(tenantId, "email", emailId));
      if (data) emails.push(JSON.parse(data));
    }

    return { emails, total };
  }

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
  query: { from?: string; subject?: string; labels?: string[] }
): Promise<EmailRecord[]> {
  const { emails } = await getEmails(kv, tenantId, 100, 0, query.labels);

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
): Promise<{ total: number; byLabel: Record<string, number>; avgProcessingTimeMs: number }> {
  const { emails } = await getEmails(kv, tenantId, 100, 0);

  const byLabel: Record<string, number> = {};
  let totalProcessingTime = 0;

  for (const email of emails) {
    totalProcessingTime += email.processingTimeMs || 0;
    for (const label of (email as any).labels || []) {
      byLabel[label] = (byLabel[label] || 0) + 1;
    }
  }

  const avgProcessingTimeMs = emails.length > 0 ? Math.round(totalProcessingTime / emails.length) : 0;

  return { total: emails.length, byLabel, avgProcessingTimeMs };
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
