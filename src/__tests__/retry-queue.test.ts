import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  addToRetryQueue,
  getRetryItems,
  getDeadLetterItems,
  getQueueStats,
} from "../retry-queue";
import type { ParsedEmail } from "../types";

const mockEmail: ParsedEmail = {
  from: "sender@example.com",
  to: "inbox@moperator.ai",
  subject: "Test Subject",
  textBody: "Test body content",
  attachments: [],
  receivedAt: "2024-01-15T10:00:00.000Z",
};

describe("retry-queue", () => {
  beforeEach(async () => {
    // Clear RETRY_QUEUE KV before each test
    const keys = await env.RETRY_QUEUE.list();
    for (const key of keys.keys) {
      await env.RETRY_QUEUE.delete(key.name);
    }
  });

  describe("addToRetryQueue", () => {
    it("adds an item to the retry queue", async () => {
      const id = await addToRetryQueue(
        env.RETRY_QUEUE,
        mockEmail,
        "test-agent",
        "https://example.com/webhook",
        "Test routing reason",
        "Connection timeout"
      );

      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
    });

    it("stores the item in KV with correct properties", async () => {
      const id = await addToRetryQueue(
        env.RETRY_QUEUE,
        mockEmail,
        "test-agent",
        "https://example.com/webhook",
        "Test routing reason",
        "Connection timeout"
      );

      const stored = await env.RETRY_QUEUE.get(`retry:${id}`);
      expect(stored).toBeDefined();

      const item = JSON.parse(stored!);
      expect(item.id).toBe(id);
      expect(item.email).toEqual(mockEmail);
      expect(item.agentId).toBe("test-agent");
      expect(item.webhookUrl).toBe("https://example.com/webhook");
      expect(item.routingReason).toBe("Test routing reason");
      expect(item.lastError).toBe("Connection timeout");
      expect(item.attempts).toBe(1);
      expect(item.maxAttempts).toBe(5);
    });

    it("sets next attempt time in the future", async () => {
      const beforeAdd = Date.now();

      const id = await addToRetryQueue(
        env.RETRY_QUEUE,
        mockEmail,
        "test-agent",
        "https://example.com/webhook",
        "Test reason",
        "Error"
      );

      const stored = await env.RETRY_QUEUE.get(`retry:${id}`);
      const item = JSON.parse(stored!);
      const nextAttempt = new Date(item.nextAttempt).getTime();

      // Next attempt should be at least 1 minute in the future
      expect(nextAttempt).toBeGreaterThan(beforeAdd);
      expect(nextAttempt - beforeAdd).toBeGreaterThanOrEqual(60000);
    });
  });

  describe("getRetryItems", () => {
    it("returns empty array when no items", async () => {
      const items = await getRetryItems(env.RETRY_QUEUE);

      expect(items).toEqual([]);
    });

    it("returns all retry items", async () => {
      await addToRetryQueue(
        env.RETRY_QUEUE,
        mockEmail,
        "agent-1",
        "https://example.com/webhook1",
        "Reason 1",
        "Error 1"
      );

      await addToRetryQueue(
        env.RETRY_QUEUE,
        mockEmail,
        "agent-2",
        "https://example.com/webhook2",
        "Reason 2",
        "Error 2"
      );

      const items = await getRetryItems(env.RETRY_QUEUE);

      expect(items).toHaveLength(2);
      expect(items.map(i => i.agentId).sort()).toEqual(["agent-1", "agent-2"]);
    });
  });

  describe("getDeadLetterItems", () => {
    it("returns empty array when no dead letters", async () => {
      const items = await getDeadLetterItems(env.RETRY_QUEUE);

      expect(items).toEqual([]);
    });
  });

  describe("getQueueStats", () => {
    it("returns zeros when queue is empty", async () => {
      const stats = await getQueueStats(env.RETRY_QUEUE);

      expect(stats.pending).toBe(0);
      expect(stats.deadLettered).toBe(0);
    });

    it("counts pending items correctly", async () => {
      await addToRetryQueue(
        env.RETRY_QUEUE,
        mockEmail,
        "agent-1",
        "https://example.com/webhook1",
        "Reason 1",
        "Error 1"
      );

      await addToRetryQueue(
        env.RETRY_QUEUE,
        mockEmail,
        "agent-2",
        "https://example.com/webhook2",
        "Reason 2",
        "Error 2"
      );

      const stats = await getQueueStats(env.RETRY_QUEUE);

      expect(stats.pending).toBe(2);
      expect(stats.deadLettered).toBe(0);
    });
  });
});
