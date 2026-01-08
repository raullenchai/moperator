/**
 * MCP (Model Context Protocol) Server Implementation
 * For Claude Desktop integration via stdio bridge
 * Spec: https://modelcontextprotocol.io
 */

import type { Tenant } from "../tenant";
import { tenantKey } from "../tenant";
import type { EmailRecord, Agent } from "../types";

// ==================== Types ====================

export interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: MCPError;
}

export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface MCPResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

// ==================== Server Configuration ====================

const SERVER_INFO = {
  name: "moperator",
  version: "1.0.0",
  capabilities: { tools: true, resources: true },
};

/**
 * Available MCP tools - descriptions guide Claude on when to use each tool
 */
export const TOOLS: MCPTool[] = [
  {
    name: "check_inbox",
    description:
      "Check your email inbox. Use this when user asks to check email, see emails, how many emails they have, or view their inbox. Returns a list of your recent emails with sender, subject, and preview.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of emails to return (default: 20, max: 100)",
        },
      },
    },
  },
  {
    name: "read_email",
    description:
      "Read the full content of a specific email. Use this when user wants to read an email, see email details, or open an email.",
    inputSchema: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "The unique ID of the email to read",
        },
      },
      required: ["email_id"],
    },
  },
  {
    name: "search_emails",
    description:
      "Search your emails by sender or subject. Use this when user asks to find emails from someone or about something.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Search by sender email address" },
        subject: { type: "string", description: "Search by subject line" },
      },
    },
  },
  {
    name: "email_stats",
    description: "Get statistics about your email inbox - total count, success rates, etc.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

/**
 * Available MCP resources (tenant-scoped)
 */
function getResources(tenantId: string): MCPResource[] {
  return [
    {
      uri: `moperator://${tenantId}/emails/recent`,
      name: "Recent Emails",
      description: "The 20 most recent emails received",
      mimeType: "application/json",
    },
    {
      uri: `moperator://${tenantId}/stats`,
      name: "Email Statistics",
      description: "Email processing statistics and metrics",
      mimeType: "application/json",
    },
  ];
}

// ==================== Request Handler ====================

export async function handleMCPRequest(
  request: MCPRequest,
  tenant: Tenant,
  kv: { agents: KVNamespace; emails: KVNamespace }
): Promise<MCPResponse> {
  const { method, params, id } = request;

  try {
    switch (method) {
      case "initialize":
        return success(id, {
          protocolVersion: "2024-11-05",
          serverInfo: SERVER_INFO,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
          },
        });

      case "tools/list":
        return success(id, { tools: TOOLS });

      case "tools/call":
        return handleToolCall(id, params as { name: string; arguments?: Record<string, unknown> }, tenant, kv);

      case "resources/list":
        return success(id, { resources: getResources(tenant.id) });

      case "resources/read":
        return handleResourceRead(id, params as { uri: string }, tenant, kv);

      case "ping":
        return success(id, {});

      default:
        return error(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return error(id, -32603, err instanceof Error ? err.message : "Internal error");
  }
}

// ==================== Tool Handlers ====================

async function handleToolCall(
  id: string | number,
  params: { name: string; arguments?: Record<string, unknown> },
  tenant: Tenant,
  kv: { agents: KVNamespace; emails: KVNamespace }
): Promise<MCPResponse> {
  const { name, arguments: args = {} } = params;

  switch (name) {
    case "check_inbox": {
      const limit = Math.min(Number(args.limit) || 20, 100);
      const { emails, total } = await getEmails(kv.emails, tenant.id, limit, 0);

      const summary = emails
        .map((e, i) => `${i + 1}. From: ${e.email.from}\n   Subject: ${e.email.subject}\n   ID: ${e.id}`)
        .join("\n\n");

      return toolResult(id, `You have ${total} emails in your inbox.\n\n${summary || "No emails found."}`);
    }

    case "read_email": {
      const emailId = String(args.email_id || "");
      if (!emailId) {
        return error(id, -32602, "email_id is required");
      }

      const record = await getEmail(kv.emails, tenant.id, emailId);
      if (!record) {
        return error(id, -32602, "Email not found");
      }

      const formatted = `From: ${record.email.from}
To: ${record.email.to}
Subject: ${record.email.subject}
Date: ${record.email.receivedAt}

${record.email.textBody || "(No text content)"}`;

      return toolResult(id, formatted);
    }

    case "search_emails": {
      const emails = await searchEmails(kv.emails, tenant.id, {
        from: args.from as string | undefined,
        subject: args.subject as string | undefined,
      });

      const summary = emails
        .map((e, i) => `${i + 1}. From: ${e.email.from}\n   Subject: ${e.email.subject}\n   ID: ${e.id}`)
        .join("\n\n");

      return toolResult(id, `Found ${emails.length} emails:\n\n${summary || "No matching emails."}`);
    }

    case "email_stats": {
      const stats = await getStats(kv.emails, tenant.id);
      return toolResult(
        id,
        `Email Stats:\n- Total: ${stats.total}\n- Successful: ${stats.successful}\n- Failed: ${stats.failed}\n- Avg Processing: ${stats.avgProcessingTimeMs}ms`
      );
    }

    default:
      return error(id, -32602, `Unknown tool: ${name}`);
  }
}

// ==================== Resource Handlers ====================

async function handleResourceRead(
  id: string | number,
  params: { uri: string },
  tenant: Tenant,
  kv: { agents: KVNamespace; emails: KVNamespace }
): Promise<MCPResponse> {
  const { uri } = params;

  const match = uri.match(/^moperator:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    return error(id, -32602, "Invalid resource URI");
  }

  const [, tenantId, resource] = match;

  if (tenantId !== tenant.id) {
    return error(id, -32602, "Access denied to resource");
  }

  let content: unknown;

  switch (resource) {
    case "emails/recent":
      content = await getEmails(kv.emails, tenant.id, 20, 0);
      break;
    case "stats":
      content = await getStats(kv.emails, tenant.id);
      break;
    default:
      return error(id, -32602, `Unknown resource: ${resource}`);
  }

  return success(id, {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(content, null, 2) }],
  });
}

// ==================== Response Helpers ====================

function success(id: string | number, result: unknown): MCPResponse {
  return { jsonrpc: "2.0", id, result };
}

function error(id: string | number, code: number, message: string): MCPResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(id: string | number, text: string): MCPResponse {
  return success(id, { content: [{ type: "text", text }] });
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
    if (data) {
      emails.push(JSON.parse(data));
    }
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

// ==================== HTTP Handler ====================

export async function handleMCPHttp(
  request: Request,
  tenant: Tenant,
  kv: { agents: KVNamespace; emails: KVNamespace }
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed. Use POST for MCP requests." }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await request.json()) as MCPRequest;

    if (!body.jsonrpc || body.jsonrpc !== "2.0") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id || null,
          error: { code: -32600, message: "Invalid Request: not JSON-RPC 2.0" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const response = await handleMCPRequest(body, tenant, kv);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error", data: err instanceof Error ? err.message : undefined },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}
