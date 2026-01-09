import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getHealthSummary,
  checkWebhookHealth,
  checkAgentHealth,
  checkAllAgentsHealth,
  reEnableAgent,
} from "../health-check";
import type { Agent } from "../types";

describe("health-check", () => {
  beforeEach(async () => {
    // Clear AGENT_REGISTRY KV before each test
    const keys = await env.AGENT_REGISTRY.list();
    for (const key of keys.keys) {
      await env.AGENT_REGISTRY.delete(key.name);
    }
  });

  describe("getHealthSummary", () => {
    it("returns empty summary when no agents", async () => {
      const result = await getHealthSummary(env.AGENT_REGISTRY);

      expect(result.agents).toEqual([]);
      expect(result.summary).toEqual({
        total: 0,
        active: 0,
        healthy: 0,
        unhealthy: 0,
      });
    });

    it("returns agents with health status", async () => {
      // Add an agent with health status
      await env.AGENT_REGISTRY.put(
        "agent:test-bot",
        JSON.stringify({
          id: "test-bot",
          name: "TestBot",
          description: "Test agent",
          webhookUrl: "https://example.com/webhook",
          active: true,
          health: {
            healthy: true,
            lastCheck: "2024-01-15T10:00:00.000Z",
            consecutiveFailures: 0,
          },
        })
      );

      const result = await getHealthSummary(env.AGENT_REGISTRY);

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].id).toBe("test-bot");
      expect(result.agents[0].health?.healthy).toBe(true);
      expect(result.summary.total).toBe(1);
      expect(result.summary.active).toBe(1);
      expect(result.summary.healthy).toBe(1);
    });

    it("counts unhealthy agents correctly", async () => {
      await env.AGENT_REGISTRY.put(
        "agent:healthy-bot",
        JSON.stringify({
          id: "healthy-bot",
          name: "HealthyBot",
          description: "Healthy agent",
          webhookUrl: "https://example.com/webhook1",
          active: true,
          health: { healthy: true, lastCheck: "2024-01-15T10:00:00.000Z", consecutiveFailures: 0 },
        })
      );

      await env.AGENT_REGISTRY.put(
        "agent:unhealthy-bot",
        JSON.stringify({
          id: "unhealthy-bot",
          name: "UnhealthyBot",
          description: "Unhealthy agent",
          webhookUrl: "https://example.com/webhook2",
          active: true,
          health: { healthy: false, lastCheck: "2024-01-15T10:00:00.000Z", consecutiveFailures: 2, lastError: "Timeout" },
        })
      );

      const result = await getHealthSummary(env.AGENT_REGISTRY);

      expect(result.summary.total).toBe(2);
      expect(result.summary.active).toBe(2);
      expect(result.summary.healthy).toBe(1);
      expect(result.summary.unhealthy).toBe(1);
    });

    it("excludes inactive agents from health counts", async () => {
      await env.AGENT_REGISTRY.put(
        "agent:inactive-bot",
        JSON.stringify({
          id: "inactive-bot",
          name: "InactiveBot",
          description: "Inactive agent",
          webhookUrl: "https://example.com/webhook",
          active: false,
          health: { healthy: false, lastCheck: "2024-01-15T10:00:00.000Z", consecutiveFailures: 5 },
        })
      );

      const result = await getHealthSummary(env.AGENT_REGISTRY);

      expect(result.summary.total).toBe(1);
      expect(result.summary.active).toBe(0);
      expect(result.summary.healthy).toBe(0);
      expect(result.summary.unhealthy).toBe(0);
    });
  });

  describe("checkWebhookHealth", () => {
    it("returns healthy for successful response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await checkWebhookHealth("https://example.com/webhook");

      expect(result.healthy).toBe(true);
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("returns healthy for 405 (method not allowed)", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 405,
        statusText: "Method Not Allowed",
      });

      const result = await checkWebhookHealth("https://example.com/webhook");

      expect(result.healthy).toBe(true);
    });

    it("returns unhealthy for error response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const result = await checkWebhookHealth("https://example.com/webhook");

      expect(result.healthy).toBe(false);
      expect(result.error).toContain("500");
    });

    it("returns unhealthy for network error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const result = await checkWebhookHealth("https://example.com/webhook");

      expect(result.healthy).toBe(false);
      expect(result.error).toBe("Network error");
    });

    it("returns timeout error for abort", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("abort"));

      const result = await checkWebhookHealth("https://example.com/webhook");

      expect(result.healthy).toBe(false);
      expect(result.error).toBe("Timeout");
    });
  });

  describe("checkAgentHealth", () => {
    it("returns healthy for agent without webhookUrl", async () => {
      const agent: Agent = {
        id: "no-webhook-agent",
        name: "No Webhook",
        description: "Agent without webhook",
        labels: ["test"],
        active: true,
      };

      const result = await checkAgentHealth(env.AGENT_REGISTRY, agent);

      expect(result.healthy).toBe(true);
      expect(result.consecutiveFailures).toBe(0);
    });

    it("checks health for agent with webhookUrl", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      const agent: Agent = {
        id: "webhook-agent",
        name: "Webhook Agent",
        description: "Agent with webhook",
        webhookUrl: "https://example.com/webhook",
        labels: ["test"],
        active: true,
      };

      const result = await checkAgentHealth(env.AGENT_REGISTRY, agent);

      expect(result.healthy).toBe(true);
      expect(result.lastSuccess).toBeDefined();
    });

    it("increments consecutiveFailures on unhealthy", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Error",
      });

      // First, add agent with existing health
      await env.AGENT_REGISTRY.put(
        "agent:failing-agent",
        JSON.stringify({
          id: "failing-agent",
          name: "Failing",
          description: "Failing agent",
          webhookUrl: "https://example.com/webhook",
          labels: ["test"],
          active: true,
          health: { healthy: false, lastCheck: "2024-01-01T00:00:00Z", consecutiveFailures: 1 },
        })
      );

      const agent: Agent = {
        id: "failing-agent",
        name: "Failing",
        description: "Failing agent",
        webhookUrl: "https://example.com/webhook",
        labels: ["test"],
        active: true,
      };

      const result = await checkAgentHealth(env.AGENT_REGISTRY, agent);

      expect(result.healthy).toBe(false);
      expect(result.consecutiveFailures).toBe(2);
    });
  });

  describe("checkAllAgentsHealth", () => {
    it("returns zeros when no agents", async () => {
      const result = await checkAllAgentsHealth(env.AGENT_REGISTRY);

      expect(result.checked).toBe(0);
      expect(result.healthy).toBe(0);
      expect(result.unhealthy).toBe(0);
      expect(result.disabled).toBe(0);
    });

    it("checks all active agents", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      await env.AGENT_REGISTRY.put(
        "agent:active-bot",
        JSON.stringify({
          id: "active-bot",
          name: "Active",
          description: "Active agent",
          webhookUrl: "https://example.com/webhook",
          labels: ["test"],
          active: true,
        })
      );

      const result = await checkAllAgentsHealth(env.AGENT_REGISTRY);

      expect(result.checked).toBe(1);
      expect(result.healthy).toBe(1);
    });

    it("skips disabled agents", async () => {
      await env.AGENT_REGISTRY.put(
        "agent:disabled-bot",
        JSON.stringify({
          id: "disabled-bot",
          name: "Disabled",
          description: "Disabled agent",
          webhookUrl: "https://example.com/webhook",
          labels: ["test"],
          active: false,
        })
      );

      const result = await checkAllAgentsHealth(env.AGENT_REGISTRY);

      expect(result.checked).toBe(0);
      expect(result.disabled).toBe(1);
    });
  });

  describe("reEnableAgent", () => {
    it("re-enables a disabled agent", async () => {
      await env.AGENT_REGISTRY.put(
        "agent:disabled-bot",
        JSON.stringify({
          id: "disabled-bot",
          name: "Disabled",
          description: "Disabled agent",
          webhookUrl: "https://example.com/webhook",
          labels: ["test"],
          active: false,
          health: { healthy: false, lastCheck: "2024-01-01T00:00:00Z", consecutiveFailures: 5 },
        })
      );

      const result = await reEnableAgent(env.AGENT_REGISTRY, "disabled-bot");

      expect(result).not.toBeNull();
      expect(result?.active).toBe(true);
      expect(result?.health?.consecutiveFailures).toBe(0);
    });

    it("returns null for non-existent agent", async () => {
      const result = await reEnableAgent(env.AGENT_REGISTRY, "nonexistent");

      expect(result).toBeNull();
    });
  });
});
