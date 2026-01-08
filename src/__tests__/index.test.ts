import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../index";

describe("API endpoints", () => {
  beforeEach(async () => {
    // Clear KV before each test
    const keys = await env.AGENT_REGISTRY.list();
    for (const key of keys.keys) {
      await env.AGENT_REGISTRY.delete(key.name);
    }
  });

  describe("GET /health", () => {
    it("returns ok status", async () => {
      const request = new Request("http://localhost/health");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: "ok", service: "moperator" });
    });
  });

  describe("GET /agents", () => {
    it("returns empty array when no agents", async () => {
      const request = new Request("http://localhost/agents");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ agents: [] });
    });

    it("returns registered agents", async () => {
      // Register an agent first
      await env.AGENT_REGISTRY.put(
        "agent:test-bot",
        JSON.stringify({
          id: "test-bot",
          name: "TestBot",
          description: "Test",
          webhookUrl: "https://example.com",
          active: true,
        })
      );

      const request = new Request("http://localhost/agents");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].id).toBe("test-bot");
    });
  });

  describe("POST /agents", () => {
    it("registers a new agent", async () => {
      const request = new Request("http://localhost/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "new-bot",
          name: "NewBot",
          description: "A new bot",
          webhookUrl: "https://example.com/webhook",
        }),
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.agent.id).toBe("new-bot");
      expect(body.agent.active).toBe(true);

      // Verify it's in KV
      const stored = await env.AGENT_REGISTRY.get("agent:new-bot");
      expect(stored).toBeDefined();
    });

    it("returns 400 for missing fields", async () => {
      const request = new Request("http://localhost/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "incomplete-bot",
          // missing name, description, webhookUrl
        }),
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Missing required fields");
    });
  });

  describe("DELETE /agents/:id", () => {
    it("deletes an existing agent", async () => {
      // Register an agent first
      await env.AGENT_REGISTRY.put(
        "agent:delete-me",
        JSON.stringify({
          id: "delete-me",
          name: "DeleteMe",
          description: "To be deleted",
          webhookUrl: "https://example.com",
          active: true,
        })
      );

      const request = new Request("http://localhost/agents/delete-me", {
        method: "DELETE",
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.deleted).toBe("delete-me");

      // Verify it's removed from KV
      const stored = await env.AGENT_REGISTRY.get("agent:delete-me");
      expect(stored).toBeNull();
    });
  });

  describe("404 handling", () => {
    it("returns 404 for unknown routes", async () => {
      const request = new Request("http://localhost/unknown");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("Not found");
    });
  });
});
