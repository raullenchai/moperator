import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { getHealthSummary } from "../health-check";

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
});
