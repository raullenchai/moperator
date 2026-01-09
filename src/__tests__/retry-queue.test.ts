import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  addToRetryQueue,
  getRetryItems,
  getDeadLetterItems,
  getQueueStats,
  processRetryQueue,
} from "../retry-queue";
import type { ParsedEmail, Agent } from "../types";

// Mock KV namespace
function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    put: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    list: vi.fn(({ prefix }: { prefix?: string } = {}) => {
      const keys = Array.from(store.keys())
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name }));
      return Promise.resolve({ keys });
    }),
  } as unknown as KVNamespace;
}

const mockEmail: ParsedEmail = {
  from: "sender@example.com",
  to: "inbox@moperator.ai",
  subject: "Test Subject",
  textBody: "Test body content",
  attachments: [],
  receivedAt: "2024-01-15T10:00:00.000Z",
};

const mockAgent: Agent = {
  id: "test-agent",
  name: "Test Agent",
  description: "A test agent",
  webhookUrl: "https://example.com/webhook",
  labels: ["finance", "important"],
  active: true,
};

const mockLabels = ["finance", "important"];
const mockMatchedLabel = "finance";

describe("retry-queue", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  describe("addToRetryQueue", () => {
    it("adds an item to the retry queue", async () => {
      const id = await addToRetryQueue(
        kv,
        mockEmail,
        mockAgent,
        mockLabels,
        mockMatchedLabel,
        "Test routing reason",
        "Connection timeout"
      );

      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
    });

    it("stores the item in KV with correct properties", async () => {
      const id = await addToRetryQueue(
        kv,
        mockEmail,
        mockAgent,
        mockLabels,
        mockMatchedLabel,
        "Test routing reason",
        "Connection timeout"
      );

      // Get the stored value from the mock
      const putCall = (kv.put as any).mock.calls.find((call: any[]) =>
        call[0].includes(`retry:${id}`)
      );
      const item = JSON.parse(putCall[1]);

      expect(item.id).toBe(id);
      expect(item.email).toEqual(mockEmail);
      expect(item.agentId).toBe("test-agent");
      expect(item.webhookUrl).toBe("https://example.com/webhook");
      expect(item.labels).toEqual(mockLabels);
      expect(item.matchedLabel).toBe(mockMatchedLabel);
      expect(item.routingReason).toBe("Test routing reason");
      expect(item.lastError).toBe("Connection timeout");
      expect(item.attempts).toBe(1);
      expect(item.maxAttempts).toBe(5);
    });

    it("sets next attempt time in the future", async () => {
      const beforeAdd = Date.now();

      const id = await addToRetryQueue(
        kv,
        mockEmail,
        mockAgent,
        mockLabels,
        mockMatchedLabel,
        "Test reason",
        "Error"
      );

      const putCall = (kv.put as any).mock.calls.find((call: any[]) =>
        call[0].includes(`retry:${id}`)
      );
      const item = JSON.parse(putCall[1]);
      const nextAttempt = new Date(item.nextAttempt).getTime();

      // Next attempt should be at least 1 minute in the future
      expect(nextAttempt).toBeGreaterThan(beforeAdd);
      expect(nextAttempt - beforeAdd).toBeGreaterThanOrEqual(60000);
    });

    it("includes tenant ID when provided", async () => {
      const id = await addToRetryQueue(
        kv,
        mockEmail,
        mockAgent,
        mockLabels,
        mockMatchedLabel,
        "Test reason",
        "Error",
        "test-tenant"
      );

      const putCall = (kv.put as any).mock.calls.find((call: any[]) =>
        call[0].includes(`retry:${id}`)
      );
      const item = JSON.parse(putCall[1]);

      expect(item.tenantId).toBe("test-tenant");
    });
  });

  describe("getRetryItems", () => {
    it("returns empty array when no items", async () => {
      const items = await getRetryItems(kv);

      expect(items).toEqual([]);
    });

    it("returns all retry items", async () => {
      const agent1: Agent = { ...mockAgent, id: "agent-1" };
      const agent2: Agent = { ...mockAgent, id: "agent-2" };

      await addToRetryQueue(
        kv,
        mockEmail,
        agent1,
        mockLabels,
        mockMatchedLabel,
        "Reason 1",
        "Error 1"
      );

      await addToRetryQueue(
        kv,
        mockEmail,
        agent2,
        mockLabels,
        mockMatchedLabel,
        "Reason 2",
        "Error 2"
      );

      const items = await getRetryItems(kv);

      expect(items).toHaveLength(2);
      expect(items.map((i) => i.agentId).sort()).toEqual(["agent-1", "agent-2"]);
    });
  });

  describe("getDeadLetterItems", () => {
    it("returns empty array when no dead letters", async () => {
      const items = await getDeadLetterItems(kv);

      expect(items).toEqual([]);
    });
  });

  describe("getQueueStats", () => {
    it("returns zeros when queue is empty", async () => {
      const stats = await getQueueStats(kv);

      expect(stats.pending).toBe(0);
      expect(stats.deadLettered).toBe(0);
    });

    it("counts pending items correctly", async () => {
      const agent1: Agent = { ...mockAgent, id: "agent-1" };
      const agent2: Agent = { ...mockAgent, id: "agent-2" };

      await addToRetryQueue(
        kv,
        mockEmail,
        agent1,
        mockLabels,
        mockMatchedLabel,
        "Reason 1",
        "Error 1"
      );

      await addToRetryQueue(
        kv,
        mockEmail,
        agent2,
        mockLabels,
        mockMatchedLabel,
        "Reason 2",
        "Error 2"
      );

      const stats = await getQueueStats(kv);

      expect(stats.pending).toBe(2);
      expect(stats.deadLettered).toBe(0);
    });
  });

  describe("processRetryQueue", () => {
    it("returns zeros when queue is empty", async () => {
      const stats = await processRetryQueue(kv, "test-signing-key");

      expect(stats.processed).toBe(0);
      expect(stats.succeeded).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.deadLettered).toBe(0);
    });

    it("skips items not yet due", async () => {
      // Add an item that won't be due for retry yet
      await addToRetryQueue(
        kv,
        mockEmail,
        mockAgent,
        mockLabels,
        mockMatchedLabel,
        "Test reason",
        "Error"
      );

      // Process immediately - item won't be due yet (scheduled for future)
      const stats = await processRetryQueue(kv, "test-signing-key");

      expect(stats.processed).toBe(0);
    });
  });
});
