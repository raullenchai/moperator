import type { ParsedEmail, RoutingDecision, EmailRecord, DispatchResult } from "./types";

const MAX_HISTORY = 100;
const HISTORY_TTL = 60 * 60 * 24 * 30; // 30 days

export async function saveEmailRecord(
  kv: KVNamespace,
  email: ParsedEmail,
  routingDecision: RoutingDecision,
  dispatchResult: DispatchResult,
  processingTimeMs: number
): Promise<string> {
  const id = generateId();
  const now = new Date().toISOString();

  const record: EmailRecord = {
    id,
    email,
    routingDecision,
    dispatchResult,
    agentId: routingDecision.agentId,
    processedAt: now,
    processingTimeMs,
  };

  // Save the record
  await kv.put(`email:${id}`, JSON.stringify(record), {
    expirationTtl: HISTORY_TTL,
  });

  // Update the index (maintain order for recent emails)
  await addToIndex(kv, id);

  console.log(`[HISTORY] Saved email ${id}`);
  return id;
}

export async function getEmailRecord(kv: KVNamespace, id: string): Promise<EmailRecord | null> {
  const data = await kv.get(`email:${id}`);
  if (!data) return null;
  return JSON.parse(data) as EmailRecord;
}

export async function getRecentEmails(
  kv: KVNamespace,
  limit: number = 20,
  offset: number = 0
): Promise<{ emails: EmailRecord[]; total: number }> {
  const index = await getIndex(kv);
  const total = index.length;

  // Get IDs for the requested page (newest first)
  const ids = index.slice(offset, offset + limit);

  // Fetch all records
  const emails: EmailRecord[] = [];
  for (const id of ids) {
    const record = await getEmailRecord(kv, id);
    if (record) {
      emails.push(record);
    }
  }

  return { emails, total };
}

export async function getEmailsByStatus(
  kv: KVNamespace,
  success: boolean
): Promise<EmailRecord[]> {
  const { emails } = await getRecentEmails(kv, MAX_HISTORY);
  return emails.filter((e) => e.dispatchResult.success === success);
}

export async function getEmailStats(kv: KVNamespace): Promise<{
  total: number;
  successful: number;
  failed: number;
  avgProcessingTimeMs: number;
}> {
  const { emails, total } = await getRecentEmails(kv, MAX_HISTORY);

  const successful = emails.filter((e) => e.dispatchResult.success).length;
  const failed = emails.filter((e) => !e.dispatchResult.success).length;
  const avgProcessingTimeMs =
    emails.length > 0
      ? emails.reduce((sum, e) => sum + e.processingTimeMs, 0) / emails.length
      : 0;

  return {
    total,
    successful,
    failed,
    avgProcessingTimeMs: Math.round(avgProcessingTimeMs),
  };
}

export async function searchEmails(
  kv: KVNamespace,
  query: {
    from?: string;
    subject?: string;
    agentId?: string;
  }
): Promise<EmailRecord[]> {
  const { emails } = await getRecentEmails(kv, MAX_HISTORY);

  return emails.filter((record) => {
    if (query.from && !record.email.from.toLowerCase().includes(query.from.toLowerCase())) {
      return false;
    }
    if (query.subject && !record.email.subject.toLowerCase().includes(query.subject.toLowerCase())) {
      return false;
    }
    if (query.agentId && record.agentId !== query.agentId) {
      return false;
    }
    return true;
  });
}

async function getIndex(kv: KVNamespace): Promise<string[]> {
  const data = await kv.get("email:index");
  if (!data) return [];
  return JSON.parse(data) as string[];
}

async function addToIndex(kv: KVNamespace, id: string): Promise<void> {
  const index = await getIndex(kv);

  // Add new ID at the beginning (newest first)
  index.unshift(id);

  // Trim to max size
  const trimmed = index.slice(0, MAX_HISTORY);

  await kv.put("email:index", JSON.stringify(trimmed));
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
