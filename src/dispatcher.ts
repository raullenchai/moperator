/**
 * Webhook Dispatcher
 *
 * Dispatches emails to agents based on label subscriptions.
 * Each agent receives at most one webhook per email, even if subscribed to multiple matching labels.
 */

import type { Agent, ParsedEmail, WebhookPayload, DispatchResult } from "./types";

/**
 * Find agents subscribed to any of the given labels.
 * Each agent appears at most once, with the first matching label recorded.
 */
export function findSubscribedAgents(
  agents: Agent[],
  emailLabels: string[]
): Array<{ agent: Agent; matchedLabel: string }> {
  const result: Array<{ agent: Agent; matchedLabel: string }> = [];
  const seenAgents = new Set<string>();

  for (const label of emailLabels) {
    for (const agent of agents) {
      if (!seenAgents.has(agent.id) && agent.labels.includes(label) && agent.active) {
        seenAgents.add(agent.id);
        result.push({ agent, matchedLabel: label });
      }
    }
  }

  return result;
}

/**
 * Dispatch email to all subscribed agents (deduplicated).
 * Returns results for each agent notified.
 */
export async function dispatchToSubscribedAgents(
  email: ParsedEmail,
  emailLabels: string[],
  agents: Agent[],
  reason: string,
  signingKey: string
): Promise<DispatchResult[]> {
  const subscribedAgents = findSubscribedAgents(agents, emailLabels);
  const results: DispatchResult[] = [];

  for (const { agent, matchedLabel } of subscribedAgents) {
    if (!agent.webhookUrl || !isValidWebhookUrl(agent.webhookUrl)) {
      console.log(`[DISPATCH] Skipping ${agent.id} - no valid webhook URL`);
      continue;
    }

    const result = await dispatchToAgent(email, emailLabels, matchedLabel, agent, reason, signingKey);
    results.push({
      agentId: agent.id,
      matchedLabel,
      ...result,
    });
  }

  return results;
}

/**
 * Dispatch to a single agent
 */
export async function dispatchToAgent(
  email: ParsedEmail,
  labels: string[],
  matchedLabel: string,
  agent: Agent,
  routingReason: string,
  signingKey: string
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const timestamp = new Date().toISOString();

  const payloadWithoutSig = {
    email,
    labels,
    matchedLabel,
    routingReason,
    timestamp,
  };

  const signature = await signPayload(JSON.stringify(payloadWithoutSig), signingKey);

  const payload: WebhookPayload = {
    ...payloadWithoutSig,
    signature,
  };

  try {
    console.log(`[WEBHOOK] POST ${agent.webhookUrl} (agent: ${agent.id}, label: ${matchedLabel})`);
    console.log(`[WEBHOOK] Signature: ${signature.slice(0, 16)}...`);

    const response = await fetch(agent.webhookUrl!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Moperator-Signature": signature,
        "X-Moperator-Timestamp": timestamp,
        "X-Moperator-Labels": labels.join(","),
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    console.log(`[WEBHOOK] Response: ${response.status} ${response.statusText}`);
    console.log(`[WEBHOOK] Response body: ${responseText.slice(0, 200)}`);

    return {
      success: response.ok,
      statusCode: response.status,
    };
  } catch (err) {
    console.error(`[WEBHOOK] Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Check if webhook URL is valid (not a placeholder)
 */
export function isValidWebhookUrl(url: string | undefined): boolean {
  if (!url) return false;
  // Skip placeholder URLs
  if (url.includes("your-webhook") || url.includes("example.com") || url.includes("placeholder")) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Sign payload with HMAC-SHA256
 */
export async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  return arrayBufferToHex(signature);
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Helper for agents to verify webhook signatures
 */
export async function verifySignature(payload: string, signature: string, secret: string): Promise<boolean> {
  const expected = await signPayload(payload, secret);
  return signature === expected;
}
