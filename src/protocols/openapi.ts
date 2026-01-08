// OpenAPI Spec Generator for ChatGPT Custom GPT Actions
// Generates OpenAPI 3.0 spec dynamically

export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    description: string;
    version: string;
  };
  servers: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
  security: Array<Record<string, string[]>>;
}

export function generateOpenAPISpec(baseUrl: string): OpenAPISpec {
  return {
    openapi: "3.0.0",
    info: {
      title: "Moperator Email API",
      description: "Email for AI — the inbox for your AI agents. Query emails, search by sender or subject, and manage routing agents. Built for LLMs, autonomous systems, and non-human intelligence.",
      version: "1.0.0",
    },
    servers: [
      {
        url: baseUrl,
        description: "Moperator API Server",
      },
    ],
    paths: {
      "/api/v1/emails": {
        get: {
          operationId: "listEmails",
          summary: "List recent emails",
          description: "Get a list of recent emails with pagination support. Returns email summaries including sender, subject, and routing information.",
          parameters: [
            {
              name: "limit",
              in: "query",
              description: "Maximum number of emails to return (default: 20, max: 100)",
              required: false,
              schema: { type: "integer", default: 20, maximum: 100 },
            },
            {
              name: "offset",
              in: "query",
              description: "Number of emails to skip for pagination",
              required: false,
              schema: { type: "integer", default: 0 },
            },
          ],
          responses: {
            "200": {
              description: "List of emails",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/EmailListResponse" },
                },
              },
            },
          },
        },
      },
      "/api/v1/emails/search": {
        get: {
          operationId: "searchEmails",
          summary: "Search emails",
          description: "Search emails by sender address, subject line, or routing agent. All filters use partial matching.",
          parameters: [
            {
              name: "from",
              in: "query",
              description: "Filter by sender email address (partial match)",
              required: false,
              schema: { type: "string" },
            },
            {
              name: "subject",
              in: "query",
              description: "Filter by subject line (partial match)",
              required: false,
              schema: { type: "string" },
            },
            {
              name: "agentId",
              in: "query",
              description: "Filter by the ID of the agent that handled the email",
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Search results",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/EmailSearchResponse" },
                },
              },
            },
          },
        },
      },
      "/api/v1/emails/{emailId}": {
        get: {
          operationId: "getEmail",
          summary: "Get email details",
          description: "Get full details of a specific email by ID, including the complete body and any attachments.",
          parameters: [
            {
              name: "emailId",
              in: "path",
              description: "The unique ID of the email",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Email details",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/EmailRecord" },
                },
              },
            },
            "404": {
              description: "Email not found",
            },
          },
        },
      },
      "/api/v1/emails/stats": {
        get: {
          operationId: "getEmailStats",
          summary: "Get email statistics",
          description: "Get email processing statistics including total count, success/failure rates, and average processing time.",
          responses: {
            "200": {
              description: "Email statistics",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/EmailStats" },
                },
              },
            },
          },
        },
      },
      "/api/v1/agents": {
        get: {
          operationId: "listAgents",
          summary: "List routing agents",
          description: "Get a list of all registered email routing agents and their current health status.",
          responses: {
            "200": {
              description: "List of agents",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/AgentListResponse" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Your Moperator API key (format: mop_xxx)",
        },
      },
      schemas: {
        EmailListResponse: {
          type: "object",
          properties: {
            emails: {
              type: "array",
              items: { $ref: "#/components/schemas/EmailSummary" },
            },
            total: { type: "integer", description: "Total number of emails" },
            limit: { type: "integer" },
            offset: { type: "integer" },
          },
        },
        EmailSearchResponse: {
          type: "object",
          properties: {
            emails: {
              type: "array",
              items: { $ref: "#/components/schemas/EmailSummary" },
            },
            count: { type: "integer", description: "Number of matching emails" },
          },
        },
        EmailSummary: {
          type: "object",
          properties: {
            id: { type: "string" },
            from: { type: "string", description: "Sender email address" },
            subject: { type: "string" },
            receivedAt: { type: "string", format: "date-time" },
            agentId: { type: "string", description: "ID of agent that handled this email" },
            success: { type: "boolean", description: "Whether processing succeeded" },
          },
        },
        EmailRecord: {
          type: "object",
          properties: {
            id: { type: "string" },
            email: {
              type: "object",
              properties: {
                from: { type: "string" },
                to: { type: "string" },
                subject: { type: "string" },
                textBody: { type: "string" },
                receivedAt: { type: "string", format: "date-time" },
              },
            },
            routingDecision: {
              type: "object",
              properties: {
                agentId: { type: "string" },
                reason: { type: "string" },
              },
            },
            dispatchResult: {
              type: "object",
              properties: {
                success: { type: "boolean" },
                statusCode: { type: "integer" },
                error: { type: "string" },
              },
            },
            processedAt: { type: "string", format: "date-time" },
            processingTimeMs: { type: "integer" },
          },
        },
        EmailStats: {
          type: "object",
          properties: {
            total: { type: "integer", description: "Total emails processed" },
            successful: { type: "integer", description: "Successfully delivered emails" },
            failed: { type: "integer", description: "Failed deliveries" },
            avgProcessingTimeMs: { type: "integer", description: "Average processing time in milliseconds" },
          },
        },
        AgentListResponse: {
          type: "object",
          properties: {
            agents: {
              type: "array",
              items: { $ref: "#/components/schemas/Agent" },
            },
          },
        },
        Agent: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            active: { type: "boolean" },
            health: {
              type: "object",
              properties: {
                healthy: { type: "boolean" },
                lastCheck: { type: "string", format: "date-time" },
                consecutiveFailures: { type: "integer" },
              },
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}

// ==================== HTTP Handler ====================

export function handleOpenAPIRequest(request: Request): Response {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  const spec = generateOpenAPISpec(baseUrl);

  // Check if YAML format is requested
  const acceptHeader = request.headers.get("Accept") || "";
  const formatParam = url.searchParams.get("format");

  if (formatParam === "yaml" || acceptHeader.includes("yaml")) {
    // Simple YAML conversion (for full YAML support, use a library)
    return new Response(jsonToYaml(spec), {
      status: 200,
      headers: {
        "Content-Type": "text/yaml",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return new Response(JSON.stringify(spec, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Simple JSON to YAML converter (basic, for display purposes)
function jsonToYaml(obj: unknown, indent: number = 0): string {
  const spaces = "  ".repeat(indent);

  if (obj === null || obj === undefined) {
    return "null";
  }

  if (typeof obj === "string") {
    if (obj.includes("\n") || obj.includes(":") || obj.includes("#")) {
      return `"${obj.replace(/"/g, '\\"')}"`;
    }
    return obj;
  }

  if (typeof obj === "number" || typeof obj === "boolean") {
    return String(obj);
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return obj
      .map((item) => {
        const value = jsonToYaml(item, indent + 1);
        if (typeof item === "object" && item !== null) {
          return `${spaces}- ${value.trim().replace(/^\s+/, "")}`;
        }
        return `${spaces}- ${value}`;
      })
      .join("\n");
  }

  if (typeof obj === "object") {
    const entries = Object.entries(obj);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, value]) => {
        const yamlValue = jsonToYaml(value, indent + 1);
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          return `${spaces}${key}:\n${yamlValue}`;
        }
        if (Array.isArray(value)) {
          return `${spaces}${key}:\n${yamlValue}`;
        }
        return `${spaces}${key}: ${yamlValue}`;
      })
      .join("\n");
  }

  return String(obj);
}
