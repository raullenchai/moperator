import type { Env, Agent } from "./types";
import { parseEmail } from "./email-parser";
import { routeEmail } from "./router";
import { dispatchToAgent } from "./dispatcher";

export default {
  // Handle incoming emails
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    console.log(`Received email from ${message.from} to ${message.to}`);

    // Parse the email
    const email = await parseEmail(message);
    console.log(`Parsed: "${email.subject}" with ${email.attachments.length} attachments`);

    // Get active agents from registry
    const agents = await getActiveAgents(env.AGENT_REGISTRY);
    console.log(`Found ${agents.length} active agents`);

    if (agents.length === 0) {
      console.error("No agents registered, email will be dropped");
      return;
    }

    // Route email using Claude
    const decision = await routeEmail(email, agents, env.ANTHROPIC_API_KEY);
    console.log(`Routed to ${decision.agentId}: ${decision.reason}`);

    // Find the target agent
    const targetAgent = agents.find((a) => a.id === decision.agentId);
    if (!targetAgent) {
      console.error(`Agent ${decision.agentId} not found`);
      return;
    }

    // Dispatch to agent
    const result = await dispatchToAgent(
      email,
      targetAgent,
      decision.reason,
      env.WEBHOOK_SIGNING_KEY
    );

    if (result.success) {
      console.log(`Dispatched to ${targetAgent.name} (${result.statusCode})`);
    } else {
      console.error(`Dispatch failed: ${result.error || result.statusCode}`);
    }
  },

  // HTTP API for managing agents
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return json({ status: "ok", service: "moperator" });
    }

    // List agents
    if (url.pathname === "/agents" && request.method === "GET") {
      const agents = await getActiveAgents(env.AGENT_REGISTRY);
      return json({ agents });
    }

    // Register agent
    if (url.pathname === "/agents" && request.method === "POST") {
      const body = (await request.json()) as Partial<Agent>;

      if (!body.id || !body.name || !body.webhookUrl || !body.description) {
        return json({ error: "Missing required fields" }, 400);
      }

      const agent: Agent = {
        id: body.id,
        name: body.name,
        description: body.description,
        webhookUrl: body.webhookUrl,
        active: body.active ?? true,
      };

      await env.AGENT_REGISTRY.put(`agent:${agent.id}`, JSON.stringify(agent));
      return json({ agent }, 201);
    }

    // Delete agent
    if (url.pathname.startsWith("/agents/") && request.method === "DELETE") {
      const agentId = url.pathname.split("/")[2];
      await env.AGENT_REGISTRY.delete(`agent:${agentId}`);
      return json({ deleted: agentId });
    }

    return json({ error: "Not found" }, 404);
  },
};

async function getActiveAgents(kv: KVNamespace): Promise<Agent[]> {
  const list = await kv.list({ prefix: "agent:" });
  const agents: Agent[] = [];

  for (const key of list.keys) {
    const data = await kv.get(key.name);
    if (data) {
      const agent = JSON.parse(data) as Agent;
      if (agent.active) {
        agents.push(agent);
      }
    }
  }

  return agents;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
