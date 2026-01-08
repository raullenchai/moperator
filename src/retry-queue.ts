import type { ParsedEmail, RetryItem, DispatchResult } from "./types";
import { dispatchToAgent } from "./dispatcher";

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 60 * 1000; // 1 minute

export async function addToRetryQueue(
  kv: KVNamespace,
  email: ParsedEmail,
  agentId: string,
  webhookUrl: string,
  routingReason: string,
  error: string
): Promise<string> {
  const id = generateId();
  const now = new Date();
  const nextAttempt = new Date(now.getTime() + BASE_DELAY_MS);

  const item: RetryItem = {
    id,
    email,
    agentId,
    webhookUrl,
    routingReason,
    attempts: 1,
    maxAttempts: MAX_ATTEMPTS,
    lastAttempt: now.toISOString(),
    nextAttempt: nextAttempt.toISOString(),
    lastError: error,
    createdAt: now.toISOString(),
  };

  await kv.put(`retry:${id}`, JSON.stringify(item), {
    expirationTtl: 60 * 60 * 24 * 7, // 7 days
  });

  // Also add to index for listing
  await addToIndex(kv, id);

  console.log(`[RETRY] Added to queue: ${id} (attempt 1/${MAX_ATTEMPTS})`);
  return id;
}

export async function processRetryQueue(
  kv: KVNamespace,
  signingKey: string
): Promise<{ processed: number; succeeded: number; failed: number; deadLettered: number }> {
  const now = new Date();
  const items = await getRetryItems(kv);

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let deadLettered = 0;

  for (const item of items) {
    // Skip if not ready for retry
    if (new Date(item.nextAttempt) > now) {
      continue;
    }

    processed++;
    console.log(`[RETRY] Processing ${item.id} (attempt ${item.attempts + 1}/${item.maxAttempts})`);

    const result = await dispatchToAgent(
      item.email,
      { id: item.agentId, name: item.agentId, description: "", webhookUrl: item.webhookUrl, active: true },
      item.routingReason,
      signingKey
    );

    if (result.success) {
      // Success - remove from queue
      await removeFromQueue(kv, item.id);
      succeeded++;
      console.log(`[RETRY] Success for ${item.id}`);
    } else {
      // Failed - update retry count or move to dead letter
      const newAttempts = item.attempts + 1;

      if (newAttempts >= item.maxAttempts) {
        // Move to dead letter queue
        await moveToDeadLetter(kv, item, result.error || `Status: ${result.statusCode}`);
        deadLettered++;
        console.log(`[RETRY] Dead lettered ${item.id} after ${newAttempts} attempts`);
      } else {
        // Schedule next retry with exponential backoff
        const delay = BASE_DELAY_MS * Math.pow(2, newAttempts - 1);
        const nextAttempt = new Date(now.getTime() + delay);

        const updatedItem: RetryItem = {
          ...item,
          attempts: newAttempts,
          lastAttempt: now.toISOString(),
          nextAttempt: nextAttempt.toISOString(),
          lastError: result.error || `Status: ${result.statusCode}`,
        };

        await kv.put(`retry:${item.id}`, JSON.stringify(updatedItem));
        failed++;
        console.log(`[RETRY] Failed ${item.id}, next retry at ${nextAttempt.toISOString()}`);
      }
    }
  }

  return { processed, succeeded, failed, deadLettered };
}

export async function getRetryItems(kv: KVNamespace): Promise<RetryItem[]> {
  const list = await kv.list({ prefix: "retry:" });
  const items: RetryItem[] = [];

  for (const key of list.keys) {
    // Skip the index key
    if (key.name === "retry:index") continue;

    const data = await kv.get(key.name);
    if (data) {
      items.push(JSON.parse(data) as RetryItem);
    }
  }

  return items;
}

export async function getDeadLetterItems(kv: KVNamespace): Promise<RetryItem[]> {
  const list = await kv.list({ prefix: "dead:" });
  const items: RetryItem[] = [];

  for (const key of list.keys) {
    const data = await kv.get(key.name);
    if (data) {
      items.push(JSON.parse(data) as RetryItem);
    }
  }

  return items;
}

export async function getQueueStats(kv: KVNamespace): Promise<{
  pending: number;
  deadLettered: number;
}> {
  const retryList = await kv.list({ prefix: "retry:" });
  const deadList = await kv.list({ prefix: "dead:" });

  // Exclude the index key from count
  const pendingCount = retryList.keys.filter(k => k.name !== "retry:index").length;

  return {
    pending: pendingCount,
    deadLettered: deadList.keys.length,
  };
}

async function removeFromQueue(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(`retry:${id}`);
  await removeFromIndex(kv, id);
}

async function moveToDeadLetter(kv: KVNamespace, item: RetryItem, finalError: string): Promise<void> {
  const deadItem = {
    ...item,
    lastError: finalError,
    deadLetteredAt: new Date().toISOString(),
  };

  await kv.put(`dead:${item.id}`, JSON.stringify(deadItem), {
    expirationTtl: 60 * 60 * 24 * 30, // 30 days
  });

  await removeFromQueue(kv, item.id);
}

async function addToIndex(kv: KVNamespace, id: string): Promise<void> {
  const indexKey = "retry:index";
  const existing = await kv.get(indexKey);
  const ids = existing ? JSON.parse(existing) : [];
  ids.push(id);
  await kv.put(indexKey, JSON.stringify(ids));
}

async function removeFromIndex(kv: KVNamespace, id: string): Promise<void> {
  const indexKey = "retry:index";
  const existing = await kv.get(indexKey);
  if (existing) {
    const ids = JSON.parse(existing).filter((i: string) => i !== id);
    await kv.put(indexKey, JSON.stringify(ids));
  }
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
