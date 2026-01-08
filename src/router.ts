import type { Agent, ParsedEmail, RoutingDecision, ClaudeResponse } from "./types";

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-3-5-haiku-latest";

export async function routeEmail(
  email: ParsedEmail,
  agents: Agent[],
  apiKey: string
): Promise<RoutingDecision> {
  const startTime = Date.now();

  if (agents.length === 0) {
    return { agentId: "unrouted", reason: "No agents available" };
  }

  if (agents.length === 1) {
    return { agentId: agents[0].id, reason: "Only one agent available" };
  }

  const prompt = buildRoutingPrompt(email, agents);

  const response = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 100,  // Reduced from 256 - we only need short JSON
      messages: [{ role: "user", content: prompt }],
    }),
  });

  console.log(`[ROUTER] Claude API took ${Date.now() - startTime}ms`);

  if (!response.ok) {
    console.error("Claude API error:", await response.text());
    return { agentId: agents[0].id, reason: "Routing failed, using default" };
  }

  const data = (await response.json()) as ClaudeResponse;
  const text = data.content[0]?.text || "";

  return parseRoutingResponse(text, agents);
}

export function buildRoutingPrompt(email: ParsedEmail, agents: Agent[]): string {
  const agentList = agents
    .map((a) => `- ${a.id}: ${a.description.slice(0, 100)}`)
    .join("\n");

  // Shorter prompt for faster response
  return `Route this email to the best agent. Reply with JSON only: {"agentId":"id","reason":"why"}

From: ${email.from}
Subject: ${email.subject}
Body: ${email.textBody.slice(0, 500)}

Agents:
${agentList}`;
}

export function parseRoutingResponse(text: string, agents: Agent[]): RoutingDecision {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as RoutingDecision;
      const validAgent = agents.find((a) => a.id === parsed.agentId);
      if (validAgent) {
        return parsed;
      }
    }
  } catch {
    console.error("Failed to parse routing response:", text);
  }

  return { agentId: agents[0].id, reason: "Parse failed, using default" };
}
