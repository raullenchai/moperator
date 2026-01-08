// MCP (Model Context Protocol) Server Implementation
// For Claude Desktop integration
// Spec: https://modelcontextprotocol.io

import type { Tenant } from "../tenant";
import { tenantKey } from "../tenant";
import type { EmailRecord, Agent } from "../types";

// MCP JSON-RPC Types
interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
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

// MCP Server State
interface MCPServerInfo {
  name: string;
  version: string;
  capabilities: {
    tools: boolean;
    resources: boolean;
  };
}

const SERVER_INFO: MCPServerInfo = {
  name: "moperator",
  version: "1.0.0",
  capabilities: {
    tools: true,
    resources: true,
  },
};

// Available Tools
const TOOLS: MCPTool[] = [
  {
    name: "list_emails",
    description: "List recent emails with optional filtering. Returns email summaries including subject, sender, and routing info.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of emails to return (default: 20, max: 100)",
        },
        offset: {
          type: "number",
          description: "Number of emails to skip for pagination",
        },
      },
    },
  },
  {
    name: "get_email",
    description: "Get full details of a specific email by ID, including body content and attachments.",
    inputSchema: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "The unique ID of the email to retrieve",
        },
      },
      required: ["email_id"],
    },
  },
  {
    name: "search_emails",
    description: "Search emails by sender, subject, or agent. Useful for finding specific emails.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Filter by sender email address (partial match)",
        },
        subject: {
          type: "string",
          description: "Filter by subject line (partial match)",
        },
        agent_id: {
          type: "string",
          description: "Filter by the agent that handled the email",
        },
      },
    },
  },
  {
    name: "list_agents",
    description: "List all registered email routing agents and their current health status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_stats",
    description: "Get email processing statistics including total counts, success rates, and average processing time.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// Available Resources
function getResources(tenantId: string): MCPResource[] {
  return [
    {
      uri: `moperator://${tenantId}/emails/recent`,
      name: "Recent Emails",
      description: "The 20 most recent emails received",
      mimeType: "application/json",
    },
    {
      uri: `moperator://${tenantId}/agents`,
      name: "Registered Agents",
      description: "List of all registered email routing agents",
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

// ==================== MCP Request Handler ====================

export async function handleMCPRequest(
  request: MCPRequest,
  tenant: Tenant,
  kv: {
    agents: KVNamespace;
    emails: KVNamespace;
  }
): Promise<MCPResponse> {
  const { method, params, id } = request;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: SERVER_INFO,
            capabilities: {
              tools: { listChanged: false },
              resources: { listChanged: false },
            },
          },
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS },
        };

      case "tools/call":
        return await handleToolCall(id, params as { name: string; arguments?: Record<string, unknown> }, tenant, kv);

      case "resources/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { resources: getResources(tenant.id) },
        };

      case "resources/read":
        return await handleResourceRead(id, params as { uri: string }, tenant, kv);

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : "Internal error",
      },
    };
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
    case "list_emails": {
      const limit = Math.min(Number(args.limit) || 20, 100);
      const offset = Number(args.offset) || 0;
      const emails = await getEmails(kv.emails, tenant.id, limit, offset);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(emails, null, 2),
            },
          ],
        },
      };
    }

    case "get_email": {
      const emailId = String(args.email_id);
      if (!emailId) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "email_id is required" },
        };
      }
      const email = await getEmail(kv.emails, tenant.id, emailId);
      if (!email) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Email not found" },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(email, null, 2),
            },
          ],
        },
      };
    }

    case "search_emails": {
      const emails = await searchEmails(kv.emails, tenant.id, {
        from: args.from as string | undefined,
        subject: args.subject as string | undefined,
        agentId: args.agent_id as string | undefined,
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(emails, null, 2),
            },
          ],
        },
      };
    }

    case "list_agents": {
      const agents = await getAgents(kv.agents, tenant.id);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(agents, null, 2),
            },
          ],
        },
      };
    }

    case "get_stats": {
      const stats = await getStats(kv.emails, tenant.id);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(stats, null, 2),
            },
          ],
        },
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${name}` },
      };
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

  // Parse URI: moperator://{tenantId}/{resource}
  const match = uri.match(/^moperator:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Invalid resource URI" },
    };
  }

  const [, tenantId, resource] = match;

  // Verify tenant access
  if (tenantId !== tenant.id) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Access denied to resource" },
    };
  }

  let content: unknown;

  switch (resource) {
    case "emails/recent":
      content = await getEmails(kv.emails, tenant.id, 20, 0);
      break;
    case "agents":
      content = await getAgents(kv.agents, tenant.id);
      break;
    case "stats":
      content = await getStats(kv.emails, tenant.id);
      break;
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown resource: ${resource}` },
      };
  }

  return {
    jsonrpc: "2.0",
    id,
    result: {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(content, null, 2),
        },
      ],
    },
  };
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

// ==================== HTTP Handler (POST for JSON-RPC) ====================

export async function handleMCPHttp(
  request: Request,
  tenant: Tenant,
  kv: { agents: KVNamespace; emails: KVNamespace }
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed. Use POST for MCP requests." }),
      { status: 405, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await request.json() as MCPRequest;

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
        error: {
          code: -32700,
          message: "Parse error",
          data: err instanceof Error ? err.message : undefined,
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

