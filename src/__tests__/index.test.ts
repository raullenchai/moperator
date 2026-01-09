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
      expect(body).toEqual({ status: "ok", service: "moperator", version: "3.0.0" });
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
      expect(body.error).toBe("Missing required fields: id, name, description");
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

  describe("GET /emails (legacy - deprecated)", () => {
    it("returns 410 for deprecated email endpoints", async () => {
      const request = new Request("http://localhost/emails");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      // Legacy endpoints return 410 (Gone) with hint to use /api/v1/
      expect(response.status).toBe(410);
      const body = (await response.json()) as { error: string; hint: string };
      expect(body.error).toContain("/api/v1/emails");
    });
  });

  describe("GET /emails/stats (legacy - deprecated)", () => {
    it("returns 410 for deprecated stats endpoint", async () => {
      const request = new Request("http://localhost/emails/stats");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      // Legacy endpoints return 410 (Gone) with hint to use /api/v1/
      expect(response.status).toBe(410);
      const body = (await response.json()) as { error: string; hint: string };
      expect(body.error).toContain("/api/v1/emails");
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

  describe("OPTIONS (CORS preflight)", () => {
    it("returns CORS headers for preflight request", async () => {
      const request = new Request("http://localhost/api/v1/emails", {
        method: "OPTIONS",
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    });
  });

  describe("GET /openapi.json", () => {
    it("returns OpenAPI spec", async () => {
      const request = new Request("http://localhost/openapi.json");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      const body = await response.json() as { openapi: string; info: { title: string } };
      expect(body.openapi).toBe("3.1.0");
      expect(body.info.title).toBe("Moperator Email API");
    });

    it("returns YAML when requested", async () => {
      const request = new Request("http://localhost/openapi.json?format=yaml");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/yaml");
    });
  });

  describe("GET /.well-known/agent.json", () => {
    it("returns A2A agent card", async () => {
      const request = new Request("http://localhost/.well-known/agent.json");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = await response.json() as { name: string; version: string };
      expect(body.name).toBe("Moperator Email Agent");
      expect(body.version).toBe("2.0.0");
    });
  });

  describe("GET /a2a/capabilities", () => {
    it("returns A2A capabilities", async () => {
      const request = new Request("http://localhost/a2a/capabilities");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = await response.json() as { capabilities: unknown[] };
      expect(body.capabilities).toHaveLength(5);
    });
  });

  describe("GET /", () => {
    it("returns 401 for unauthenticated request", async () => {
      // Root path falls through to authenticated endpoints
      const request = new Request("http://localhost/");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(401);
    });
  });

  describe("POST /retry/process", () => {
    it("processes retry queue", async () => {
      const request = new Request("http://localhost/retry/process", {
        method: "POST",
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = await response.json() as { processed: number };
      expect(body.processed).toBe(0);
    });
  });

  describe("GET /health/agents", () => {
    it("returns health summary", async () => {
      const request = new Request("http://localhost/health/agents");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = await response.json() as { agents: unknown[]; summary: object };
      expect(body.agents).toEqual([]);
      expect(body.summary).toBeDefined();
    });
  });
});
