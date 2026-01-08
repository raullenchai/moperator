import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  saveEmailRecord,
  getEmailRecord,
  getRecentEmails,
  getEmailStats,
  searchEmails,
} from "../email-history";
import type { ParsedEmail, RoutingDecision, DispatchResult } from "../types";

const mockEmail: ParsedEmail = {
  from: "sender@example.com",
  to: "inbox@moperator.ai",
  subject: "Test Subject",
  textBody: "Test body content",
  attachments: [],
  receivedAt: "2024-01-15T10:00:00.000Z",
};

const mockRoutingDecision: RoutingDecision = {
  agentId: "test-agent",
  reason: "Test routing reason",
};

const mockSuccessResult: DispatchResult = {
  success: true,
  statusCode: 200,
};

const mockFailureResult: DispatchResult = {
  success: false,
  statusCode: 500,
  error: "Server error",
};

describe("email-history", () => {
  beforeEach(async () => {
    // Clear EMAIL_HISTORY KV before each test
    const keys = await env.EMAIL_HISTORY.list();
    for (const key of keys.keys) {
      await env.EMAIL_HISTORY.delete(key.name);
    }
  });

  describe("saveEmailRecord", () => {
    it("saves an email record and returns an ID", async () => {
      const id = await saveEmailRecord(
        env.EMAIL_HISTORY,
        mockEmail,
        mockRoutingDecision,
        mockSuccessResult,
        150
      );

      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
    });

    it("stores the record in KV", async () => {
      const id = await saveEmailRecord(
        env.EMAIL_HISTORY,
        mockEmail,
        mockRoutingDecision,
        mockSuccessResult,
        150
      );

      const stored = await env.EMAIL_HISTORY.get(`email:${id}`);
      expect(stored).toBeDefined();

      const record = JSON.parse(stored!);
      expect(record.id).toBe(id);
      expect(record.email).toEqual(mockEmail);
      expect(record.routingDecision).toEqual(mockRoutingDecision);
      expect(record.dispatchResult).toEqual(mockSuccessResult);
      expect(record.processingTimeMs).toBe(150);
    });
  });

  describe("getEmailRecord", () => {
    it("retrieves a saved record", async () => {
      const id = await saveEmailRecord(
        env.EMAIL_HISTORY,
        mockEmail,
        mockRoutingDecision,
        mockSuccessResult,
        150
      );

      const record = await getEmailRecord(env.EMAIL_HISTORY, id);

      expect(record).toBeDefined();
      expect(record!.id).toBe(id);
      expect(record!.email.from).toBe("sender@example.com");
    });

    it("returns null for non-existent ID", async () => {
      const record = await getEmailRecord(env.EMAIL_HISTORY, "non-existent");

      expect(record).toBeNull();
    });
  });

  describe("getRecentEmails", () => {
    it("returns empty list when no emails", async () => {
      const { emails, total } = await getRecentEmails(env.EMAIL_HISTORY);

      expect(emails).toEqual([]);
      expect(total).toBe(0);
    });

    it("returns saved emails in order (newest first)", async () => {
      await saveEmailRecord(
        env.EMAIL_HISTORY,
        { ...mockEmail, subject: "First" },
        mockRoutingDecision,
        mockSuccessResult,
        100
      );

      await saveEmailRecord(
        env.EMAIL_HISTORY,
        { ...mockEmail, subject: "Second" },
        mockRoutingDecision,
        mockSuccessResult,
        100
      );

      const { emails, total } = await getRecentEmails(env.EMAIL_HISTORY);

      expect(total).toBe(2);
      expect(emails).toHaveLength(2);
      expect(emails[0].email.subject).toBe("Second");
      expect(emails[1].email.subject).toBe("First");
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await saveEmailRecord(
          env.EMAIL_HISTORY,
          { ...mockEmail, subject: `Email ${i}` },
          mockRoutingDecision,
          mockSuccessResult,
          100
        );
      }

      const { emails, total } = await getRecentEmails(env.EMAIL_HISTORY, 2);

      expect(total).toBe(5);
      expect(emails).toHaveLength(2);
    });

    it("respects offset parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await saveEmailRecord(
          env.EMAIL_HISTORY,
          { ...mockEmail, subject: `Email ${i}` },
          mockRoutingDecision,
          mockSuccessResult,
          100
        );
      }

      const { emails, total } = await getRecentEmails(env.EMAIL_HISTORY, 2, 2);

      expect(total).toBe(5);
      expect(emails).toHaveLength(2);
    });
  });

  describe("getEmailStats", () => {
    it("returns zeros when no emails", async () => {
      const stats = await getEmailStats(env.EMAIL_HISTORY);

      expect(stats.total).toBe(0);
      expect(stats.successful).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.avgProcessingTimeMs).toBe(0);
    });

    it("counts successful and failed emails", async () => {
      await saveEmailRecord(
        env.EMAIL_HISTORY,
        mockEmail,
        mockRoutingDecision,
        mockSuccessResult,
        100
      );

      await saveEmailRecord(
        env.EMAIL_HISTORY,
        mockEmail,
        mockRoutingDecision,
        mockFailureResult,
        200
      );

      await saveEmailRecord(
        env.EMAIL_HISTORY,
        mockEmail,
        mockRoutingDecision,
        mockSuccessResult,
        150
      );

      const stats = await getEmailStats(env.EMAIL_HISTORY);

      expect(stats.total).toBe(3);
      expect(stats.successful).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.avgProcessingTimeMs).toBe(150);
    });
  });

  describe("searchEmails", () => {
    beforeEach(async () => {
      await saveEmailRecord(
        env.EMAIL_HISTORY,
        { ...mockEmail, from: "alice@example.com", subject: "Hello World" },
        { agentId: "agent-a", reason: "Test" },
        mockSuccessResult,
        100
      );

      await saveEmailRecord(
        env.EMAIL_HISTORY,
        { ...mockEmail, from: "bob@example.com", subject: "Meeting Request" },
        { agentId: "agent-b", reason: "Test" },
        mockSuccessResult,
        100
      );
    });

    it("filters by from address", async () => {
      const results = await searchEmails(env.EMAIL_HISTORY, { from: "alice" });

      expect(results).toHaveLength(1);
      expect(results[0].email.from).toBe("alice@example.com");
    });

    it("filters by subject", async () => {
      const results = await searchEmails(env.EMAIL_HISTORY, { subject: "meeting" });

      expect(results).toHaveLength(1);
      expect(results[0].email.subject).toBe("Meeting Request");
    });

    it("filters by agentId", async () => {
      const results = await searchEmails(env.EMAIL_HISTORY, { agentId: "agent-a" });

      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe("agent-a");
    });

    it("combines multiple filters", async () => {
      const results = await searchEmails(env.EMAIL_HISTORY, {
        from: "bob",
        agentId: "agent-b"
      });

      expect(results).toHaveLength(1);
      expect(results[0].email.from).toBe("bob@example.com");
    });

    it("returns empty array when no matches", async () => {
      const results = await searchEmails(env.EMAIL_HISTORY, { from: "nobody" });

      expect(results).toHaveLength(0);
    });
  });
});
