import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  dispatchToAgent,
  signPayload,
  verifySignature,
  findSubscribedAgents,
  dispatchToSubscribedAgents,
  isValidWebhookUrl,
} from "../dispatcher";
import type { Agent, ParsedEmail } from "../types";

const mockAgent: Agent = {
  id: "test-bot",
  name: "TestBot",
  description: "Test agent",
  webhookUrl: "https://example.com/webhook",
  labels: ["finance", "important"],
  active: true,
};

const mockEmail: ParsedEmail = {
  from: "sender@example.com",
  to: "inbox@moperator.ai",
  subject: "Test Subject",
  textBody: "Test body content",
  attachments: [],
  receivedAt: "2024-01-15T10:00:00.000Z",
};

const mockLabels = ["finance", "important"];
const mockMatchedLabel = "finance";

describe("dispatcher", () => {
  describe("signPayload", () => {
    it("generates consistent signatures for same input", async () => {
      const payload = '{"test": "data"}';
      const secret = "test-secret";

      const sig1 = await signPayload(payload, secret);
      const sig2 = await signPayload(payload, secret);

      expect(sig1).toBe(sig2);
    });

    it("generates different signatures for different payloads", async () => {
      const secret = "test-secret";

      const sig1 = await signPayload('{"test": "data1"}', secret);
      const sig2 = await signPayload('{"test": "data2"}', secret);

      expect(sig1).not.toBe(sig2);
    });

    it("generates different signatures for different secrets", async () => {
      const payload = '{"test": "data"}';

      const sig1 = await signPayload(payload, "secret1");
      const sig2 = await signPayload(payload, "secret2");

      expect(sig1).not.toBe(sig2);
    });

    it("returns hex string", async () => {
      const sig = await signPayload("test", "secret");

      expect(sig).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe("verifySignature", () => {
    it("returns true for valid signature", async () => {
      const payload = '{"test": "data"}';
      const secret = "test-secret";
      const signature = await signPayload(payload, secret);

      const result = await verifySignature(payload, signature, secret);

      expect(result).toBe(true);
    });

    it("returns false for invalid signature", async () => {
      const payload = '{"test": "data"}';
      const secret = "test-secret";

      const result = await verifySignature(payload, "invalid-sig", secret);

      expect(result).toBe(false);
    });

    it("returns false for tampered payload", async () => {
      const secret = "test-secret";
      const signature = await signPayload('{"test": "original"}', secret);

      const result = await verifySignature('{"test": "tampered"}', signature, secret);

      expect(result).toBe(false);
    });
  });

  describe("dispatchToAgent", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("returns success on 200 response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: "OK",
          text: () => Promise.resolve("OK"),
        })
      );

      const result = await dispatchToAgent(
        mockEmail,
        mockLabels,
        mockMatchedLabel,
        mockAgent,
        "Test routing reason",
        "test-secret"
      );

      expect(result).toEqual({
        success: true,
        statusCode: 200,
      });
    });

    it("returns failure on 500 response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: () => Promise.resolve("Error"),
        })
      );

      const result = await dispatchToAgent(
        mockEmail,
        mockLabels,
        mockMatchedLabel,
        mockAgent,
        "Test routing reason",
        "test-secret"
      );

      expect(result).toEqual({
        success: false,
        statusCode: 500,
      });
    });

    it("returns error on network failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Network error"))
      );

      const result = await dispatchToAgent(
        mockEmail,
        mockLabels,
        mockMatchedLabel,
        mockAgent,
        "Test routing reason",
        "test-secret"
      );

      expect(result).toEqual({
        success: false,
        error: "Network error",
      });
    });

    it("sends correct headers", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve("OK"),
      });
      vi.stubGlobal("fetch", mockFetch);

      await dispatchToAgent(
        mockEmail,
        mockLabels,
        mockMatchedLabel,
        mockAgent,
        "Test reason",
        "test-secret"
      );

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://example.com/webhook");
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");
      expect(options.headers["X-Moperator-Signature"]).toBeDefined();
      expect(options.headers["X-Moperator-Timestamp"]).toBeDefined();
      expect(options.headers["X-Moperator-Labels"]).toBe("finance,important");
    });

    it("sends correct payload structure", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve("OK"),
      });
      vi.stubGlobal("fetch", mockFetch);

      await dispatchToAgent(
        mockEmail,
        mockLabels,
        mockMatchedLabel,
        mockAgent,
        "Test reason",
        "test-secret"
      );

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.email).toEqual(mockEmail);
      expect(body.labels).toEqual(mockLabels);
      expect(body.matchedLabel).toBe(mockMatchedLabel);
      expect(body.routingReason).toBe("Test reason");
      expect(body.timestamp).toBeDefined();
      expect(body.signature).toBeDefined();
    });
  });

  describe("findSubscribedAgents", () => {
    it("returns agents subscribed to given labels", () => {
      const agents: Agent[] = [
        { ...mockAgent, id: "bot1", labels: ["finance", "urgent"] },
        { ...mockAgent, id: "bot2", labels: ["support"] },
        { ...mockAgent, id: "bot3", labels: ["finance"] },
      ];

      const result = findSubscribedAgents(agents, ["finance"]);

      expect(result).toHaveLength(2);
      expect(result.map(r => r.agent.id)).toEqual(["bot1", "bot3"]);
    });

    it("deduplicates agents when multiple labels match", () => {
      const agents: Agent[] = [
        { ...mockAgent, id: "bot1", labels: ["finance", "urgent"] },
      ];

      const result = findSubscribedAgents(agents, ["finance", "urgent"]);

      expect(result).toHaveLength(1);
      expect(result[0].agent.id).toBe("bot1");
      expect(result[0].matchedLabel).toBe("finance"); // First match
    });

    it("returns empty array when no agents match", () => {
      const agents: Agent[] = [
        { ...mockAgent, id: "bot1", labels: ["support"] },
      ];

      const result = findSubscribedAgents(agents, ["finance"]);

      expect(result).toHaveLength(0);
    });

    it("excludes inactive agents", () => {
      const agents: Agent[] = [
        { ...mockAgent, id: "bot1", labels: ["finance"], active: false },
        { ...mockAgent, id: "bot2", labels: ["finance"], active: true },
      ];

      const result = findSubscribedAgents(agents, ["finance"]);

      expect(result).toHaveLength(1);
      expect(result[0].agent.id).toBe("bot2");
    });
  });

  describe("dispatchToSubscribedAgents", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("dispatches to all subscribed agents", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve("OK"),
      }));

      const agents: Agent[] = [
        { ...mockAgent, id: "bot1", labels: ["finance"], webhookUrl: "https://bot1.real-server.io/hook" },
        { ...mockAgent, id: "bot2", labels: ["finance"], webhookUrl: "https://bot2.real-server.io/hook" },
      ];

      const results = await dispatchToSubscribedAgents(
        mockEmail, ["finance"], agents, "Test reason", "secret"
      );

      expect(results).toHaveLength(2);
      expect(results[0].agentId).toBe("bot1");
      expect(results[1].agentId).toBe("bot2");
    });

    it("skips agents without webhook URL", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve("OK"),
      }));

      const agents: Agent[] = [
        { ...mockAgent, id: "bot1", labels: ["finance"], webhookUrl: undefined },
        { ...mockAgent, id: "bot2", labels: ["finance"], webhookUrl: "https://bot2.real-server.io/hook" },
      ];

      const results = await dispatchToSubscribedAgents(
        mockEmail, ["finance"], agents, "Test reason", "secret"
      );

      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe("bot2");
    });

    it("skips agents with placeholder webhook URLs", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve("OK"),
      }));

      const agents: Agent[] = [
        { ...mockAgent, id: "bot1", labels: ["finance"], webhookUrl: "https://your-webhook.example.com" },
        { ...mockAgent, id: "bot2", labels: ["finance"], webhookUrl: "https://real-server.io/hook" },
      ];

      const results = await dispatchToSubscribedAgents(
        mockEmail, ["finance"], agents, "Test reason", "secret"
      );

      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe("bot2");
    });
  });

  describe("isValidWebhookUrl", () => {
    it("returns false for undefined", () => {
      expect(isValidWebhookUrl(undefined)).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isValidWebhookUrl("")).toBe(false);
    });

    it("returns false for placeholder URLs", () => {
      expect(isValidWebhookUrl("https://your-webhook.example.com")).toBe(false);
      expect(isValidWebhookUrl("https://example.com/hook")).toBe(false);
      expect(isValidWebhookUrl("https://placeholder.io")).toBe(false);
    });

    it("returns true for valid HTTPS URLs", () => {
      expect(isValidWebhookUrl("https://my-server.io/webhook")).toBe(true);
      expect(isValidWebhookUrl("https://api.company.com/hook")).toBe(true);
    });

    it("returns true for HTTP URLs", () => {
      expect(isValidWebhookUrl("http://localhost:3000/hook")).toBe(true);
    });

    it("returns false for invalid URLs", () => {
      expect(isValidWebhookUrl("not-a-url")).toBe(false);
      expect(isValidWebhookUrl("ftp://server.com/file")).toBe(false);
    });
  });
});
