import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  labelEmail,
  buildLabelingPrompt,
  parseLabelingResponse,
} from "../labeler";
import type { Label, ParsedEmail } from "../types";

const mockLabels: Label[] = [
  {
    id: "finance",
    name: "Finance",
    description: "Invoices, receipts, bank statements, and financial documents",
  },
  {
    id: "support",
    name: "Support",
    description: "Customer support inquiries and help requests",
  },
  {
    id: "catch-all",
    name: "Other",
    description: "Emails that don't fit other categories",
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

describe("labeler", () => {
  describe("labelEmail", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("returns catch-all when no labels available", async () => {
      const result = await labelEmail(mockEmail, [], "test-api-key");
      expect(result).toEqual({
        labels: ["catch-all"],
        reason: "No labels defined",
      });
    });

    it("returns catch-all when only catch-all is available", async () => {
      const result = await labelEmail(mockEmail, [mockLabels[2]], "test-api-key");
      expect(result).toEqual({
        labels: ["catch-all"],
        reason: "Only catch-all label available",
      });
    });

    it("falls back to catch-all on API error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          text: () => Promise.resolve("API Error"),
        })
      );

      const result = await labelEmail(mockEmail, mockLabels, "test-api-key");
      expect(result).toEqual({
        labels: ["catch-all"],
        reason: "Labeling failed, using catch-all",
      });
    });

    it("parses valid Claude response with single label", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              content: [
                {
                  type: "text",
                  text: '{"labels": ["finance"], "reason": "Invoice detected"}',
                },
              ],
            }),
        })
      );

      const result = await labelEmail(mockEmail, mockLabels, "test-api-key");
      expect(result).toEqual({
        labels: ["finance"],
        reason: "Invoice detected",
      });
    });

    it("parses valid Claude response with multiple labels", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              content: [
                {
                  type: "text",
                  text: '{"labels": ["finance", "support"], "reason": "Financial support request"}',
                },
              ],
            }),
        })
      );

      const result = await labelEmail(mockEmail, mockLabels, "test-api-key");
      expect(result).toEqual({
        labels: ["finance", "support"],
        reason: "Financial support request",
      });
    });
  });

  describe("buildLabelingPrompt", () => {
    it("includes email details in prompt", () => {
      const prompt = buildLabelingPrompt(mockEmail, mockLabels);

      expect(prompt).toContain("From: sender@example.com");
      expect(prompt).toContain("Subject: Test Subject");
      expect(prompt).toContain("Body: Test body content");
    });

    it("includes all labels in prompt", () => {
      const prompt = buildLabelingPrompt(mockEmail, mockLabels);

      expect(prompt).toContain("finance: Invoices, receipts, bank statements");
      expect(prompt).toContain("support: Customer support inquiries");
      expect(prompt).toContain("catch-all: Emails that don't fit");
    });

    it("truncates long email bodies", () => {
      const longEmail = {
        ...mockEmail,
        textBody: "x".repeat(2000),
      };
      const prompt = buildLabelingPrompt(longEmail, mockLabels);

      // Body is truncated to 500 chars for faster labeling
      expect(prompt).toContain("x".repeat(500));
      expect(prompt).not.toContain("x".repeat(501));
    });
  });

  describe("parseLabelingResponse", () => {
    it("parses valid JSON response with single label", () => {
      const response = '{"labels": ["finance"], "reason": "Invoice detected"}';
      const result = parseLabelingResponse(response, mockLabels);

      expect(result).toEqual({
        labels: ["finance"],
        reason: "Invoice detected",
      });
    });

    it("parses valid JSON response with multiple labels", () => {
      const response = '{"labels": ["finance", "support"], "reason": "Mixed content"}';
      const result = parseLabelingResponse(response, mockLabels);

      expect(result).toEqual({
        labels: ["finance", "support"],
        reason: "Mixed content",
      });
    });

    it("extracts JSON from text with extra content", () => {
      const response =
        'Here is my analysis: {"labels": ["support"], "reason": "Support request"} Thank you.';
      const result = parseLabelingResponse(response, mockLabels);

      expect(result).toEqual({
        labels: ["support"],
        reason: "Support request",
      });
    });

    it("falls back to catch-all on invalid JSON", () => {
      const result = parseLabelingResponse("not valid json", mockLabels);

      expect(result).toEqual({
        labels: ["catch-all"],
        reason: "Parse failed, using catch-all",
      });
    });

    it("filters out invalid labels and keeps valid ones", () => {
      const response = '{"labels": ["finance", "unknown-label"], "reason": "test"}';
      const result = parseLabelingResponse(response, mockLabels);

      expect(result).toEqual({
        labels: ["finance"],
        reason: "test",
      });
    });

    it("falls back to catch-all when all labels are invalid", () => {
      const response = '{"labels": ["unknown1", "unknown2"], "reason": "test"}';
      const result = parseLabelingResponse(response, mockLabels);

      expect(result).toEqual({
        labels: ["catch-all"],
        reason: "Parse failed, using catch-all",
      });
    });
  });
});
