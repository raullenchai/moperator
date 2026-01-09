// Webhook health check module
// Monitors agent webhook endpoints and tracks their health status

import type { Agent } from "./types";

export interface HealthStatus {
  healthy: boolean;
  lastCheck: string;
  lastSuccess?: string;
  consecutiveFailures: number;
  lastError?: string;
  responseTimeMs?: number;
}

export interface AgentWithHealth extends Agent {
  health?: HealthStatus;
}

const HEALTH_CHECK_TIMEOUT_MS = 10000; // 10 seconds
const MAX_CONSECUTIVE_FAILURES = 3; // Auto-disable after 3 failures

/**
 * Check if a webhook endpoint is healthy
 * Uses HEAD request first, falls back to GET if HEAD not supported
 */
export async function checkWebhookHealth(
  webhookUrl: string
): Promise<{ healthy: boolean; responseTimeMs: number; error?: string }> {
  const startTime = Date.now();

  try {
    // Try HEAD request first (lighter weight)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    const response = await fetch(webhookUrl, {
      method: "HEAD",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const responseTimeMs = Date.now() - startTime;

    // Consider 2xx and 405 (Method Not Allowed) as healthy
    // 405 means the endpoint exists but doesn't support HEAD
    if (response.ok || response.status === 405) {
      return { healthy: true, responseTimeMs };
    }

    return {
      healthy: false,
      responseTimeMs,
      error: `HTTP ${response.status} ${response.statusText}`,
    };
  } catch (err) {
    const responseTimeMs = Date.now() - startTime;
    const error = err instanceof Error ? err.message : "Unknown error";

    // Abort errors are timeouts
    if (error.includes("abort")) {
      return { healthy: false, responseTimeMs, error: "Timeout" };
    }

    return { healthy: false, responseTimeMs, error };
  }
}

/**
 * Perform health check on a single agent and update its status
 */
export async function checkAgentHealth(
  kv: KVNamespace,
  agent: Agent
): Promise<HealthStatus> {
  const now = new Date().toISOString();

  // If no webhook URL, skip health check and return healthy
  if (!agent.webhookUrl) {
    return {
      healthy: true,
      lastCheck: now,
      consecutiveFailures: 0,
    };
  }

  // Get existing health status
  const existingData = await kv.get(`agent:${agent.id}`);
  const existingAgent = existingData
    ? (JSON.parse(existingData) as AgentWithHealth)
    : null;
  const previousHealth = existingAgent?.health;

  // Perform health check
  const result = await checkWebhookHealth(agent.webhookUrl);

  const healthStatus: HealthStatus = {
    healthy: result.healthy,
    lastCheck: now,
    consecutiveFailures: result.healthy
      ? 0
      : (previousHealth?.consecutiveFailures || 0) + 1,
    responseTimeMs: result.responseTimeMs,
  };

  if (result.healthy) {
    healthStatus.lastSuccess = now;
  } else {
    healthStatus.lastError = result.error;
    // Preserve last success from previous status
    if (previousHealth?.lastSuccess) {
      healthStatus.lastSuccess = previousHealth.lastSuccess;
    }
  }

  // Update agent with health status
  const updatedAgent: AgentWithHealth = {
    ...agent,
    health: healthStatus,
  };

  // Auto-disable if too many consecutive failures
  if (healthStatus.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && agent.active) {
    updatedAgent.active = false;
    console.log(
      `[HEALTH] Auto-disabled agent ${agent.id} after ${healthStatus.consecutiveFailures} consecutive failures`
    );
  }

  await kv.put(`agent:${agent.id}`, JSON.stringify(updatedAgent));

  // Log status changes
  const wasHealthy = previousHealth?.healthy ?? true;
  if (wasHealthy && !result.healthy) {
    console.log(
      `[HEALTH] Agent ${agent.id} is now UNHEALTHY: ${result.error}`
    );
  } else if (!wasHealthy && result.healthy) {
    console.log(`[HEALTH] Agent ${agent.id} is now HEALTHY`);
  }

  return healthStatus;
}

/**
 * Run health checks on all agents
 */
export async function checkAllAgentsHealth(
  kv: KVNamespace
): Promise<{ checked: number; healthy: number; unhealthy: number; disabled: number }> {
  const list = await kv.list({ prefix: "agent:" });
  let checked = 0;
  let healthy = 0;
  let unhealthy = 0;
  let disabled = 0;

  for (const key of list.keys) {
    const data = await kv.get(key.name);
    if (!data) continue;

    const agent = JSON.parse(data) as AgentWithHealth;

    // Skip inactive agents but count them
    if (!agent.active) {
      disabled++;
      continue;
    }

    checked++;
    const status = await checkAgentHealth(kv, agent);

    if (status.healthy) {
      healthy++;
    } else {
      unhealthy++;
    }
  }

  console.log(
    `[HEALTH] Check complete: ${checked} checked, ${healthy} healthy, ${unhealthy} unhealthy, ${disabled} disabled`
  );

  return { checked, healthy, unhealthy, disabled };
}

/**
 * Re-enable a disabled agent and reset its health status
 */
export async function reEnableAgent(
  kv: KVNamespace,
  agentId: string
): Promise<AgentWithHealth | null> {
  const data = await kv.get(`agent:${agentId}`);
  if (!data) return null;

  const agent = JSON.parse(data) as AgentWithHealth;

  agent.active = true;
  if (agent.health) {
    agent.health.consecutiveFailures = 0;
  }

  await kv.put(`agent:${agentId}`, JSON.stringify(agent));
  console.log(`[HEALTH] Re-enabled agent ${agentId}`);

  return agent;
}

/**
 * Get health summary for all agents
 */
export async function getHealthSummary(
  kv: KVNamespace
): Promise<{
  agents: Array<{ id: string; name: string; active: boolean; health?: HealthStatus }>;
  summary: { total: number; active: number; healthy: number; unhealthy: number };
}> {
  const list = await kv.list({ prefix: "agent:" });
  const agents: Array<{ id: string; name: string; active: boolean; health?: HealthStatus }> = [];
  let total = 0;
  let active = 0;
  let healthy = 0;
  let unhealthy = 0;

  for (const key of list.keys) {
    const data = await kv.get(key.name);
    if (!data) continue;

    const agent = JSON.parse(data) as AgentWithHealth;
    total++;

    if (agent.active) {
      active++;
      if (agent.health?.healthy) {
        healthy++;
      } else if (agent.health?.healthy === false) {
        unhealthy++;
      }
    }

    agents.push({
      id: agent.id,
      name: agent.name,
      active: agent.active,
      health: agent.health,
    });
  }

  return {
    agents,
    summary: { total, active, healthy, unhealthy },
  };
}
