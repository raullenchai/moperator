import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../index";

interface AgentResponse {
  agents: Array<{ id: string; name: string }>;
}

interface SingleAgentResponse {
  agent: { id: string; active: boolean };
}

interface ErrorResponse {
  error: string;
}

interface DeleteResponse {
  deleted: string;
}

interface EmailsResponse {
  emails: Array<{ id: string }>;
  total: number;
}

interface StatsResponse {
  total: number;
  successful: number;
  failed: number;
}

interface RetryStatsResponse {
  pending: number;
  deadLettered: number;
}

describe("API endpoints", () => {
  beforeEach(async () => {
    // Clear KV before each test
    const registryKeys = await env.AGENT_REGISTRY.list();
    for (const key of registryKeys.keys) {
      await env.AGENT_REGISTRY.delete(key.name);
    }

    const historyKeys = await env.EMAIL_HISTORY.list();
    for (const key of historyKeys.keys) {
      await env.EMAIL_HISTORY.delete(key.name);
    }

    const retryKeys = await env.RETRY_QUEUE.list();
    for (const key of retryKeys.keys) {
      await env.RETRY_QUEUE.delete(key.name);
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
      expect(body).toEqual({ status: "ok", service: "moperator", version: "2.0.0" });
    });
  });

  describe("GET /agents", () => {
    it("returns empty array when no agents", async () => {
      const request = new Request("http://localhost/agents");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = (await response.json()) as AgentResponse;
      expect(body).toEqual({ agents: [] });
    });

    it("returns registered agents", async () => {
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
      const body = (await response.json()) as AgentResponse;
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
      const body = (await response.json()) as SingleAgentResponse;
      expect(body.agent.id).toBe("new-bot");
      expect(body.agent.active).toBe(true);

      const stored = await env.AGENT_REGISTRY.get("agent:new-bot");
      expect(stored).toBeDefined();
    });

    it("returns 400 for missing fields", async () => {
      const request = new Request("http://localhost/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "incomplete-bot",
        }),
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe("Missing required fields: id, name, description, webhookUrl");
    });
  });

  describe("DELETE /agents/:id", () => {
    it("deletes an existing agent", async () => {
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
      const body = (await response.json()) as DeleteResponse;
      expect(body.deleted).toBe("delete-me");

      const stored = await env.AGENT_REGISTRY.get("agent:delete-me");
      expect(stored).toBeNull();
    });
  });

  describe("GET /emails", () => {
    it("returns empty list when no emails", async () => {
      const request = new Request("http://localhost/emails");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = (await response.json()) as EmailsResponse;
      expect(body.emails).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  describe("GET /emails/stats", () => {
    it("returns stats with zeros when no emails", async () => {
      const request = new Request("http://localhost/emails/stats");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = (await response.json()) as StatsResponse;
      expect(body.total).toBe(0);
      expect(body.successful).toBe(0);
      expect(body.failed).toBe(0);
    });
  });

  describe("GET /retry/stats", () => {
    it("returns stats with zeros when queue is empty", async () => {
      const request = new Request("http://localhost/retry/stats");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = (await response.json()) as RetryStatsResponse;
      expect(body.pending).toBe(0);
      expect(body.deadLettered).toBe(0);
    });
  });

  describe("GET /retry/pending", () => {
    it("returns empty list when no pending retries", async () => {
      const request = new Request("http://localhost/retry/pending");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: unknown[]; count: number };
      expect(body.items).toEqual([]);
      expect(body.count).toBe(0);
    });
  });

  describe("GET /retry/dead", () => {
    it("returns empty list when no dead letters", async () => {
      const request = new Request("http://localhost/retry/dead");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: unknown[]; count: number };
      expect(body.items).toEqual([]);
      expect(body.count).toBe(0);
    });
  });

  describe("authentication for unknown routes", () => {
    it("returns 401 for unknown routes without auth", async () => {
      // Unknown routes fall into the authenticated tenant section
      // and require a valid API key
      const request = new Request("http://localhost/unknown");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(401);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe("Authorization required. Use Bearer token with your API key.");
    });
  });
});
