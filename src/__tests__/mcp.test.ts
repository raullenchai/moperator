import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleMCPRequest, TOOLS, type MCPRequest, type MCPResponse } from "../protocols/mcp";
import type { Tenant } from "../tenant";

// Mock tenant
const mockTenant: Tenant = {
  id: "test-tenant",
  name: "Test Tenant",
  email: "test@moperator.ai",
  apiKey: "mop_test_key",
  apiKeyPrefix: "mop_test",
  settings: {
    maxAgents: 10,
    maxEmailsPerDay: 100,
    rateLimitPerMinute: 60,
    enabledProtocols: ["mcp", "openapi"],
  },
  usage: {
    emailsToday: 0,
    emailsTotal: 0,
    agentCount: 0,
  },
  createdAt: "2024-01-01T00:00:00.000Z",
};

// Mock KV namespace
function createMockKV(data: Record<string, string> = {}): KVNamespace {
  return {
    get: vi.fn((key: string) => Promise.resolve(data[key] || null)),
    put: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
    list: vi.fn(() => Promise.resolve({ keys: [], list_complete: true, cacheStatus: null })),
    getWithMetadata: vi.fn(() => Promise.resolve({ value: null, metadata: null, cacheStatus: null })),
  } as unknown as KVNamespace;
}

// Mock email data
const mockEmailIndex = JSON.stringify(["email-1", "email-2"]);
const mockEmail1 = JSON.stringify({
  id: "email-1",
  email: {
    from: "sender@example.com",
    to: "test@moperator.ai",
    subject: "Test Email 1",
    textBody: "This is the body of test email 1",
    receivedAt: "2024-01-15T10:00:00.000Z",
  },
  agentId: "test-agent",
  routingDecision: { agentId: "test-agent", reason: "Test routing" },
  dispatchResult: { success: true, statusCode: 200 },
  processedAt: "2024-01-15T10:00:01.000Z",
  processingTimeMs: 1000,
});
const mockEmail2 = JSON.stringify({
  id: "email-2",
  email: {
    from: "another@example.com",
    to: "test@moperator.ai",
    subject: "Test Email 2",
    textBody: "This is the body of test email 2",
    receivedAt: "2024-01-15T11:00:00.000Z",
  },
  agentId: "test-agent",
  routingDecision: { agentId: "test-agent", reason: "Test routing" },
  dispatchResult: { success: false, statusCode: 500, error: "Server error" },
  processedAt: "2024-01-15T11:00:01.000Z",
  processingTimeMs: 2000,
});

describe("MCP Protocol", () => {
  let mockKV: { agents: KVNamespace; emails: KVNamespace };

  beforeEach(() => {
    mockKV = {
      agents: createMockKV(),
      emails: createMockKV({
        "user:test-tenant:email:index": mockEmailIndex,
        "user:test-tenant:email:email-1": mockEmail1,
        "user:test-tenant:email:email-2": mockEmail2,
      }),
    };
  });

  describe("TOOLS configuration", () => {
    it("exports correct tool definitions", () => {
      expect(TOOLS).toHaveLength(4);
      expect(TOOLS.map((t) => t.name)).toEqual(["check_inbox", "read_email", "search_emails", "email_stats"]);
    });

    it("check_inbox has correct schema", () => {
      const tool = TOOLS.find((t) => t.name === "check_inbox");
      expect(tool?.inputSchema.properties).toHaveProperty("limit");
    });

    it("read_email requires email_id", () => {
      const tool = TOOLS.find((t) => t.name === "read_email");
      expect(tool?.inputSchema.required).toContain("email_id");
    });
  });

  describe("handleMCPRequest", () => {
    it("handles initialize method", async () => {
      const request: MCPRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      };

      const response = await handleMCPRequest(request, mockTenant, mockKV);

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect(response.result).toHaveProperty("protocolVersion");
      expect(response.result).toHaveProperty("serverInfo");
      expect((response.result as any).serverInfo.name).toBe("moperator");
    });

    it("handles tools/list method", async () => {
      const request: MCPRequest = {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      };

      const response = await handleMCPRequest(request, mockTenant, mockKV);

      expect(response.result).toHaveProperty("tools");
      expect((response.result as any).tools).toHaveLength(4);
    });

    it("handles ping method", async () => {
      const request: MCPRequest = {
        jsonrpc: "2.0",
        id: 3,
        method: "ping",
      };

      const response = await handleMCPRequest(request, mockTenant, mockKV);

      expect(response.result).toEqual({});
    });

    it("returns error for unknown method", async () => {
      const request: MCPRequest = {
        jsonrpc: "2.0",
        id: 4,
        method: "unknown/method",
      };

      const response = await handleMCPRequest(request, mockTenant, mockKV);

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.message).toContain("Method not found");
    });
  });

  describe("tools/call - check_inbox", () => {
    it("returns email list with count", async () => {
      const request: MCPRequest = {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "check_inbox", arguments: {} },
      };

      const response = await handleMCPRequest(request, mockTenant, mockKV);

      expect(response.result).toHaveProperty("content");
      const content = (response.result as any).content[0].text;
      expect(content).toContain("You have 2 emails");
      expect(content).toContain("sender@example.com");
      expect(content).toContain("Test Email 1");
    });

    it("respects limit parameter", async () => {
      const request: MCPRequest = {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "check_inbox", arguments: { limit: 1 } },
      };

      const response = await handleMCPRequest(request, mockTenant, mockKV);

      const content = (response.result as any).content[0].text;
      expect(content).toContain("You have 2 emails");
      expect(content).toContain("email-1");
      expect(content).not.toContain("email-2");
    });
  });

  describe("tools/call - read_email", () => {
    it("returns full email content", async () => {
      const request: MCPRequest = {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "read_email", arguments: { email_id: "email-1" } },
      };

      const response = await handleMCPRequest(request, mockTenant, mockKV);

      const content = (response.result as any).content[0].text;
      expect(content).toContain("From: sender@example.com");
      expect(content).toContain("Subject: Test Email 1");
      expect(content).toContain("This is the body of test email 1");
    });

    it("returns error for missing email_id", async () => {
      const request: MCPRequest = {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "read_email", arguments: {} },
      };

      const response = await handleMCPRequest(request, mockTenant, mockKV);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain("email_id is required");
    });

    it("returns error for non-existent email", async () => {
      const request: MCPRequest = {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "read_email", arguments: { email_id: "nonexistent" } },
      };

      const response = await handleMCPRequest(request, mockTenant, mockKV);

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain("Email not found");
    });
  });

  describe("tools/call - search_emails", () => {
    it("searches by sender", async () => {
      const request: MCPRequest = {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "search_emails", arguments: { from: "sender@" } },
      };

      const response = await handleMCPRequest(request, mockTenant, mockKV);

      const content = (response.result as any).content[0].text;
      expect(content).toContain("Found 1 emails");
      expect(content).toContain("sender@example.com");
    });

    it("searches by subject", async () => {
      const request: MCPRequest = {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "search_emails", arguments: { subject: "Email 2" } },
      };

      const response = await handleMCPRequest(request, mockTenant, mockKV);

      const content = (response.result as any).content[0].text;
      expect(content).toContain("Found 1 emails");
      expect(content).toContain("Test Email 2");
    });
  });

  describe("tools/call - email_stats", () => {
    it("returns email statistics", async () => {
      const request: MCPRequest = {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "email_stats", arguments: {} },
      };

      const response = await handleMCPRequest(request, mockTenant, mockKV);

      const content = (response.result as any).content[0].text;
      expect(content).toContain("Total: 2");
      expect(content).toContain("Successful: 1");
      expect(content).toContain("Failed: 1");
      expect(content).toContain("Avg Processing: 1500ms");
    });
  });

  describe("resources/list", () => {
    it("returns available resources", async () => {
      const request: MCPRequest = {
        jsonrpc: "2.0",
        id: 13,
        method: "resources/list",
      };

      const response = await handleMCPRequest(request, mockTenant, mockKV);

      expect(response.result).toHaveProperty("resources");
      const resources = (response.result as any).resources;
      expect(resources.length).toBeGreaterThan(0);
      expect(resources[0].uri).toContain("moperator://test-tenant");
    });
  });
});
