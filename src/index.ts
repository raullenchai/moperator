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
    const startTime = Date.now();
    console.log("=".repeat(60));
    console.log("[MOPERATOR] EMAIL RECEIVED");
    console.log("=".repeat(60));
    console.log(`[EMAIL] From: ${message.from}`);
    console.log(`[EMAIL] To: ${message.to}`);
    console.log(`[EMAIL] Headers: ${JSON.stringify(Object.fromEntries(message.headers))}`);

    // Parse the email
    console.log("[PARSE] Parsing email content...");
    const email = await parseEmail(message);
    console.log(`[PARSE] Subject: "${email.subject}"`);
    console.log(`[PARSE] Body preview: "${email.textBody.slice(0, 200)}..."`);
    console.log(`[PARSE] Attachments: ${email.attachments.length}`);

    // Get active agents from registry
    console.log("[REGISTRY] Fetching active agents...");
    const agents = await getActiveAgents(env.AGENT_REGISTRY);
    console.log(`[REGISTRY] Found ${agents.length} active agents: ${agents.map(a => a.id).join(", ")}`);

    if (agents.length === 0) {
      console.error("[ERROR] No agents registered, email will be dropped");
      return;
    }

    // Route email using Claude
    console.log("[ROUTER] Calling Claude for routing decision...");
    const decision = await routeEmail(email, agents, env.ANTHROPIC_API_KEY);
    console.log(`[ROUTER] Decision: ${decision.agentId}`);
    console.log(`[ROUTER] Reason: ${decision.reason}`);

    // Find the target agent
    const targetAgent = agents.find((a) => a.id === decision.agentId);
    if (!targetAgent) {
      console.error(`[ERROR] Agent ${decision.agentId} not found in registry`);
      return;
    }

    // Dispatch to agent
    console.log(`[DISPATCH] Sending to ${targetAgent.name} at ${targetAgent.webhookUrl}`);
    const result = await dispatchToAgent(
      email,
      targetAgent,
      decision.reason,
      env.WEBHOOK_SIGNING_KEY
    );

    const duration = Date.now() - startTime;
    if (result.success) {
      console.log(`[DISPATCH] SUCCESS - Status: ${result.statusCode}`);
      console.log(`[COMPLETE] Email processed in ${duration}ms`);
    } else {
      console.error(`[DISPATCH] FAILED - ${result.error || `Status: ${result.statusCode}`}`);
    }
    console.log("=".repeat(60));
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

    // Test routing (simulates email routing without actual email)
    if (url.pathname === "/test-route" && request.method === "POST") {
      const body = (await request.json()) as {
        from?: string;
        subject?: string;
        body?: string;
      };

      const simulatedEmail = {
        from: body.from || "test@example.com",
        to: "inbox@moperator.ai",
        subject: body.subject || "Test email",
        textBody: body.body || "",
        attachments: [],
        receivedAt: new Date().toISOString(),
      };

      const agents = await getActiveAgents(env.AGENT_REGISTRY);
      if (agents.length === 0) {
        return json({ error: "No agents registered" }, 400);
      }

      const decision = await routeEmail(simulatedEmail, agents, env.ANTHROPIC_API_KEY);

      return json({
        email: simulatedEmail,
        routing: decision,
        availableAgents: agents.map((a) => ({ id: a.id, name: a.name })),
      });
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
