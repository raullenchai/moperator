import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  routeEmail,
  buildRoutingPrompt,
  parseRoutingResponse,
} from "../router";
import type { Agent, ParsedEmail } from "../types";

const mockAgents: Agent[] = [
  {
    id: "finance-bot",
    name: "FinanceBot",
    description: "Handles invoices and financial documents",
    webhookUrl: "https://example.com/finance",
    active: true,
  },
  {
    id: "support-bot",
    name: "SupportBot",
    description: "Handles customer support inquiries",
    webhookUrl: "https://example.com/support",
    active: true,
  },
];

const mockEmail: ParsedEmail = {
  from: "sender@example.com",
  to: "inbox@moperator.ai",
  subject: "Test Subject",
  textBody: "Test body content",
  attachments: [],
  receivedAt: "2024-01-15T10:00:00.000Z",
};

describe("router", () => {
  describe("routeEmail", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("returns unrouted when no agents available", async () => {
      const result = await routeEmail(mockEmail, [], "test-api-key");
      expect(result).toEqual({
        agentId: "unrouted",
        reason: "No agents available",
      });
    });

    it("returns the only agent when just one is available", async () => {
      const result = await routeEmail(mockEmail, [mockAgents[0]], "test-api-key");
      expect(result).toEqual({
        agentId: "finance-bot",
        reason: "Only one agent available",
      });
    });

    it("falls back to first agent on API error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          text: () => Promise.resolve("API Error"),
        })
      );

      const result = await routeEmail(mockEmail, mockAgents, "test-api-key");
      expect(result).toEqual({
        agentId: "finance-bot",
        reason: "Routing failed, using default",
      });
    });

    it("parses valid Claude response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              content: [
                {
                  type: "text",
                  text: '{"agentId": "support-bot", "reason": "Customer inquiry"}',
                },
              ],
            }),
        })
      );

      const result = await routeEmail(mockEmail, mockAgents, "test-api-key");
      expect(result).toEqual({
        agentId: "support-bot",
        reason: "Customer inquiry",
      });
    });
  });

  describe("buildRoutingPrompt", () => {
    it("includes email details in prompt", () => {
      const prompt = buildRoutingPrompt(mockEmail, mockAgents);

      expect(prompt).toContain("From: sender@example.com");
      expect(prompt).toContain("Subject: Test Subject");
      expect(prompt).toContain("Body: Test body content");
    });

    it("includes all agents in prompt", () => {
      const prompt = buildRoutingPrompt(mockEmail, mockAgents);

      expect(prompt).toContain("finance-bot: FinanceBot");
      expect(prompt).toContain("support-bot: SupportBot");
    });

    it("truncates long email bodies", () => {
      const longEmail = {
        ...mockEmail,
        textBody: "x".repeat(2000),
      };
      const prompt = buildRoutingPrompt(longEmail, mockAgents);

      expect(prompt).toContain("x".repeat(1000));
      expect(prompt).not.toContain("x".repeat(1001));
    });
  });

  describe("parseRoutingResponse", () => {
    it("parses valid JSON response", () => {
      const response = '{"agentId": "finance-bot", "reason": "Invoice detected"}';
      const result = parseRoutingResponse(response, mockAgents);

      expect(result).toEqual({
        agentId: "finance-bot",
        reason: "Invoice detected",
      });
    });

    it("extracts JSON from text with extra content", () => {
      const response =
        'Here is my analysis: {"agentId": "support-bot", "reason": "Support request"} Thank you.';
      const result = parseRoutingResponse(response, mockAgents);

      expect(result).toEqual({
        agentId: "support-bot",
        reason: "Support request",
      });
    });

    it("falls back to first agent on invalid JSON", () => {
      const result = parseRoutingResponse("not valid json", mockAgents);

      expect(result).toEqual({
        agentId: "finance-bot",
        reason: "Parse failed, using default",
      });
    });

    it("falls back to first agent when agentId not found", () => {
      const response = '{"agentId": "unknown-bot", "reason": "test"}';
      const result = parseRoutingResponse(response, mockAgents);

      expect(result).toEqual({
        agentId: "finance-bot",
        reason: "Parse failed, using default",
      });
    });
  });
});
