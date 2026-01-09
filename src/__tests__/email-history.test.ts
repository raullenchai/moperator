import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  saveEmailRecord,
  getEmailRecord,
  getRecentEmails,
  getEmailStats,
  searchEmails,
} from "../email-history";
import type { ParsedEmail, LabelingDecision, DispatchResult } from "../types";

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

const mockLabelingDecision: LabelingDecision = {
  labels: ["finance", "important"],
  reason: "Invoice from accounting",
};

const mockSuccessResults: DispatchResult[] = [
  {
    agentId: "agent-a",
    matchedLabel: "finance",
    success: true,
    statusCode: 200,
  },
];

const mockMixedResults: DispatchResult[] = [
  {
    agentId: "agent-a",
    matchedLabel: "finance",
    success: true,
    statusCode: 200,
  },
  {
    agentId: "agent-b",
    matchedLabel: "important",
    success: false,
    statusCode: 500,
    error: "Server error",
  },
];

const TENANT_ID = "test-tenant";

describe("email-history", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  describe("saveEmailRecord", () => {
    it("saves an email record and returns an ID", async () => {
      const id = await saveEmailRecord(
        kv,
        TENANT_ID,
        mockEmail,
        mockLabelingDecision,
        mockSuccessResults,
        150
      );

      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
    });

    it("stores the record with correct structure", async () => {
      const id = await saveEmailRecord(
        kv,
        TENANT_ID,
        mockEmail,
        mockLabelingDecision,
        mockSuccessResults,
        150
      );

      // Verify KV put was called with correct key
      expect(kv.put).toHaveBeenCalledWith(
        expect.stringContaining(`user:${TENANT_ID}:email:${id}`),
        expect.any(String),
        expect.any(Object)
      );

      // Get the stored value from the mock
      const putCall = (kv.put as any).mock.calls.find((call: any[]) =>
        call[0].includes(`email:${id}`)
      );
      const record = JSON.parse(putCall[1]);

      expect(record.id).toBe(id);
      expect(record.email).toEqual(mockEmail);
      expect(record.labels).toEqual(mockLabelingDecision.labels);
      expect(record.labelingDecision).toEqual(mockLabelingDecision);
      expect(record.dispatchResults).toEqual(mockSuccessResults);
      expect(record.processingTimeMs).toBe(150);
    });

    it("updates label indexes", async () => {
      await saveEmailRecord(
        kv,
        TENANT_ID,
        mockEmail,
        mockLabelingDecision,
        mockSuccessResults,
        150
      );

      // Should have updated both label indexes (finance and important)
      expect(kv.put).toHaveBeenCalledWith(
        `user:${TENANT_ID}:label:finance:emails`,
        expect.any(String)
      );
      expect(kv.put).toHaveBeenCalledWith(
        `user:${TENANT_ID}:label:important:emails`,
        expect.any(String)
      );
    });
  });

  describe("getEmailRecord", () => {
    it("retrieves a saved record", async () => {
      const id = await saveEmailRecord(
        kv,
        TENANT_ID,
        mockEmail,
        mockLabelingDecision,
        mockSuccessResults,
        150
      );

      const record = await getEmailRecord(kv, TENANT_ID, id);

      expect(record).toBeDefined();
      expect(record!.id).toBe(id);
      expect(record!.email.from).toBe("sender@example.com");
      expect(record!.labels).toEqual(["finance", "important"]);
    });

    it("returns null for non-existent ID", async () => {
      const record = await getEmailRecord(kv, TENANT_ID, "non-existent");

      expect(record).toBeNull();
    });
  });

  describe("getRecentEmails", () => {
    it("returns empty list when no emails", async () => {
      const { emails, total } = await getRecentEmails(kv, TENANT_ID);

      expect(emails).toEqual([]);
      expect(total).toBe(0);
    });

    it("returns saved emails in order (newest first)", async () => {
      await saveEmailRecord(
        kv,
        TENANT_ID,
        { ...mockEmail, subject: "First" },
        mockLabelingDecision,
        mockSuccessResults,
        100
      );

      await saveEmailRecord(
        kv,
        TENANT_ID,
        { ...mockEmail, subject: "Second" },
        mockLabelingDecision,
        mockSuccessResults,
        100
      );

      const { emails, total } = await getRecentEmails(kv, TENANT_ID);

      expect(total).toBe(2);
      expect(emails).toHaveLength(2);
      expect(emails[0].email.subject).toBe("Second");
      expect(emails[1].email.subject).toBe("First");
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await saveEmailRecord(
          kv,
          TENANT_ID,
          { ...mockEmail, subject: `Email ${i}` },
          mockLabelingDecision,
          mockSuccessResults,
          100
        );
      }

      const { emails, total } = await getRecentEmails(kv, TENANT_ID, 2);

      expect(total).toBe(5);
      expect(emails).toHaveLength(2);
    });

    it("respects offset parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await saveEmailRecord(
          kv,
          TENANT_ID,
          { ...mockEmail, subject: `Email ${i}` },
          mockLabelingDecision,
          mockSuccessResults,
          100
        );
      }

      const { emails, total } = await getRecentEmails(kv, TENANT_ID, 2, 2);

      expect(total).toBe(5);
      expect(emails).toHaveLength(2);
    });
  });

  describe("getEmailStats", () => {
    it("returns zeros when no emails", async () => {
      const stats = await getEmailStats(kv, TENANT_ID);

      expect(stats.total).toBe(0);
      expect(stats.successful).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.avgProcessingTimeMs).toBe(0);
    });

    it("counts by label and dispatch status", async () => {
      await saveEmailRecord(
        kv,
        TENANT_ID,
        mockEmail,
        mockLabelingDecision,
        mockSuccessResults,
        100
      );

      await saveEmailRecord(
        kv,
        TENANT_ID,
        mockEmail,
        { labels: ["support"], reason: "Support request" },
        mockMixedResults,
        200
      );

      const stats = await getEmailStats(kv, TENANT_ID);

      expect(stats.total).toBe(2);
      expect(stats.byLabel).toHaveProperty("finance");
      expect(stats.byLabel).toHaveProperty("important");
      expect(stats.byLabel).toHaveProperty("support");
      expect(stats.avgProcessingTimeMs).toBe(150);
    });
  });

  describe("searchEmails", () => {
    beforeEach(async () => {
      await saveEmailRecord(
        kv,
        TENANT_ID,
        { ...mockEmail, from: "alice@example.com", subject: "Hello World" },
        { labels: ["finance"], reason: "Test" },
        mockSuccessResults,
        100
      );

      await saveEmailRecord(
        kv,
        TENANT_ID,
        { ...mockEmail, from: "bob@example.com", subject: "Meeting Request" },
        { labels: ["support"], reason: "Test" },
        mockSuccessResults,
        100
      );
    });

    it("filters by from address", async () => {
      const results = await searchEmails(kv, TENANT_ID, { from: "alice" });

      expect(results).toHaveLength(1);
      expect(results[0].email.from).toBe("alice@example.com");
    });

    it("filters by subject", async () => {
      const results = await searchEmails(kv, TENANT_ID, { subject: "meeting" });

      expect(results).toHaveLength(1);
      expect(results[0].email.subject).toBe("Meeting Request");
    });

    it("combines multiple filters", async () => {
      const results = await searchEmails(kv, TENANT_ID, {
        from: "bob",
        subject: "meeting",
      });

      expect(results).toHaveLength(1);
      expect(results[0].email.from).toBe("bob@example.com");
    });

    it("returns empty array when no matches", async () => {
      const results = await searchEmails(kv, TENANT_ID, { from: "nobody" });

      expect(results).toHaveLength(0);
    });
  });
});
