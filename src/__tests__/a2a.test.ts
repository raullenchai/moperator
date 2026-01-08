import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getAgentCard,
  CAPABILITIES,
  executeTask,
  handleAgentCardRequest,
  handleCapabilitiesRequest,
  type A2ATaskRequest,
} from "../protocols/a2a";
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
    enabledProtocols: ["a2a"],
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

describe("A2A Protocol", () => {
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

  describe("Agent Card", () => {
    it("generates valid agent card", () => {
      const card = getAgentCard("https://api.example.com");

      expect(card.name).toBe("Moperator Email Agent");
      expect(card.url).toBe("https://api.example.com");
      expect(card.version).toBe("1.0.0");
      expect(card.authentication.type).toBe("bearer");
    });

    it("includes all capabilities", () => {
      const card = getAgentCard("https://api.example.com");

      expect(card.capabilities).toHaveLength(4);
      expect(card.capabilities.map((c) => c.name)).toEqual([
        "check_inbox",
        "read_email",
        "search_emails",
        "email_stats",
      ]);
    });
  });

  describe("CAPABILITIES", () => {
    it("check_inbox has correct schema", () => {
      const cap = CAPABILITIES.find((c) => c.name === "check_inbox");
      expect(cap).toBeDefined();
      expect(cap?.inputSchema.properties).toHaveProperty("limit");
      expect(cap?.outputSchema.properties).toHaveProperty("emails");
      expect(cap?.outputSchema.properties).toHaveProperty("total");
    });

    it("read_email requires email_id", () => {
      const cap = CAPABILITIES.find((c) => c.name === "read_email");
      expect(cap?.inputSchema.required).toContain("email_id");
    });
  });

  describe("executeTask", () => {
    it("executes check_inbox successfully", async () => {
      const request: A2ATaskRequest = {
        capability: "check_inbox",
        input: { limit: 10 },
      };

      const task = await executeTask(request, mockTenant, mockKV);

      expect(task.status).toBe("completed");
      expect(task.capability).toBe("check_inbox");
      expect(task.output).toHaveProperty("emails");
      expect(task.output).toHaveProperty("total");
      expect((task.output as any).total).toBe(2);
    });

    it("executes read_email successfully", async () => {
      const request: A2ATaskRequest = {
        capability: "read_email",
        input: { email_id: "email-1" },
      };

      const task = await executeTask(request, mockTenant, mockKV);

      expect(task.status).toBe("completed");
      expect(task.output).toHaveProperty("email");
      expect((task.output as any).email.from).toBe("sender@example.com");
      expect((task.output as any).email.subject).toBe("Test Email 1");
    });

    it("fails read_email without email_id", async () => {
      const request: A2ATaskRequest = {
        capability: "read_email",
        input: {},
      };

      const task = await executeTask(request, mockTenant, mockKV);

      expect(task.status).toBe("failed");
      expect(task.error).toContain("email_id is required");
    });

    it("fails read_email for non-existent email", async () => {
      const request: A2ATaskRequest = {
        capability: "read_email",
        input: { email_id: "nonexistent" },
      };

      const task = await executeTask(request, mockTenant, mockKV);

      expect(task.status).toBe("failed");
      expect(task.error).toContain("Email not found");
    });

    it("executes search_emails by sender", async () => {
      const request: A2ATaskRequest = {
        capability: "search_emails",
        input: { from: "sender@" },
      };

      const task = await executeTask(request, mockTenant, mockKV);

      expect(task.status).toBe("completed");
      expect((task.output as any).count).toBe(1);
      expect((task.output as any).emails[0].from).toBe("sender@example.com");
    });

    it("executes email_stats successfully", async () => {
      const request: A2ATaskRequest = {
        capability: "email_stats",
        input: {},
      };

      const task = await executeTask(request, mockTenant, mockKV);

      expect(task.status).toBe("completed");
      expect((task.output as any).total).toBe(2);
      expect((task.output as any).successful).toBe(1);
      expect((task.output as any).failed).toBe(1);
    });

    it("fails for unknown capability", async () => {
      const request: A2ATaskRequest = {
        capability: "unknown_capability",
        input: {},
      };

      const task = await executeTask(request, mockTenant, mockKV);

      expect(task.status).toBe("failed");
      expect(task.error).toContain("Unknown capability");
    });

    it("generates unique task IDs", async () => {
      const request: A2ATaskRequest = {
        capability: "email_stats",
        input: {},
      };

      const task1 = await executeTask(request, mockTenant, mockKV);
      const task2 = await executeTask(request, mockTenant, mockKV);

      expect(task1.id).not.toBe(task2.id);
      expect(task1.id).toMatch(/^task_\d+_[a-z0-9]+$/);
    });

    it("includes timestamps", async () => {
      const request: A2ATaskRequest = {
        capability: "email_stats",
        input: {},
      };

      const task = await executeTask(request, mockTenant, mockKV);

      expect(task.createdAt).toBeDefined();
      expect(task.completedAt).toBeDefined();
      expect(new Date(task.createdAt).getTime()).toBeLessThanOrEqual(new Date(task.completedAt!).getTime());
    });
  });

  describe("HTTP Handlers", () => {
    it("handleAgentCardRequest returns valid JSON", async () => {
      const request = new Request("https://api.example.com/.well-known/agent.json");
      const response = handleAgentCardRequest(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");

      const body = await response.json();
      expect(body.name).toBe("Moperator Email Agent");
      expect(body.url).toBe("https://api.example.com");
    });

    it("handleCapabilitiesRequest returns capabilities", async () => {
      const response = handleCapabilitiesRequest();

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.capabilities).toHaveLength(4);
    });

    it("includes CORS headers", () => {
      const request = new Request("https://api.example.com/.well-known/agent.json");
      const response = handleAgentCardRequest(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });

  describe("Email formatting", () => {
    it("check_inbox returns formatted emails with preview", async () => {
      const request: A2ATaskRequest = {
        capability: "check_inbox",
        input: {},
      };

      const task = await executeTask(request, mockTenant, mockKV);
      const emails = (task.output as any).emails;

      expect(emails[0]).toHaveProperty("id");
      expect(emails[0]).toHaveProperty("from");
      expect(emails[0]).toHaveProperty("subject");
      expect(emails[0]).toHaveProperty("preview");
      expect(emails[0]).toHaveProperty("receivedAt");
    });

    it("read_email returns full email content", async () => {
      const request: A2ATaskRequest = {
        capability: "read_email",
        input: { email_id: "email-1" },
      };

      const task = await executeTask(request, mockTenant, mockKV);
      const email = (task.output as any).email;

      expect(email).toHaveProperty("body");
      expect(email.body).toBe("This is the body of test email 1");
    });
  });
});
