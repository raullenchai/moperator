import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  dispatchToAgent,
  signPayload,
  verifySignature,
} from "../dispatcher";
import type { Agent, ParsedEmail } from "../types";

const mockAgent: Agent = {
  id: "test-bot",
  name: "TestBot",
  description: "Test agent",
  webhookUrl: "https://example.com/webhook",
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

      await dispatchToAgent(mockEmail, mockAgent, "Test reason", "test-secret");

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://example.com/webhook");
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");
      expect(options.headers["X-Moperator-Signature"]).toBeDefined();
      expect(options.headers["X-Moperator-Timestamp"]).toBeDefined();
    });

    it("sends correct payload structure", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve("OK"),
      });
      vi.stubGlobal("fetch", mockFetch);

      await dispatchToAgent(mockEmail, mockAgent, "Test reason", "test-secret");

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.email).toEqual(mockEmail);
      expect(body.routedTo).toBe("test-bot");
      expect(body.routingReason).toBe("Test reason");
      expect(body.timestamp).toBeDefined();
      expect(body.signature).toBeDefined();
    });
  });
});
