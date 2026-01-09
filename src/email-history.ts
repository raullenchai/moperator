/**
 * Email History Storage
 *
 * Stores and retrieves email records with label information.
 * Supports tenant-scoped operations and label-based filtering.
 */

import type { ParsedEmail, LabelingDecision, EmailRecord, DispatchResult, EmailStatus } from "./types";
import { tenantKey } from "./tenant";

const MAX_HISTORY = 100;
const HISTORY_TTL = 60 * 60 * 24 * 30; // 30 days

/**
 * Save an email record after processing
 */
export async function saveEmailRecord(
  kv: KVNamespace,
  tenantId: string,
  email: ParsedEmail,
  labelingDecision: LabelingDecision,
  dispatchResults: DispatchResult[],
  processingTimeMs: number
): Promise<string> {
  const id = generateId();
  const now = new Date().toISOString();

  const record: EmailRecord = {
    id,
    email,
    labels: labelingDecision.labels,
    labelingDecision,
    dispatchResults,
    processedAt: now,
    processingTimeMs,
    status: 'unread',
  };

  // Save the record
  await kv.put(tenantKey(tenantId, "email", id), JSON.stringify(record), {
    expirationTtl: HISTORY_TTL,
  });

  // Update the main index (maintain order for recent emails)
  await addToIndex(kv, tenantId, id);

  // Update label indexes for efficient filtering
  for (const label of labelingDecision.labels) {
    await addToLabelIndex(kv, tenantId, label, id);
  }

  console.log(`[HISTORY] Saved email ${id} with labels: ${labelingDecision.labels.join(", ")}`);
  return id;
}

/**
 * Get a specific email record by ID
 */
export async function getEmailRecord(
  kv: KVNamespace,
  tenantId: string,
  id: string
): Promise<EmailRecord | null> {
  const data = await kv.get(tenantKey(tenantId, "email", id));
  if (!data) return null;
  const record = JSON.parse(data) as EmailRecord;
  // Ensure status exists for older records
  if (!record.status) {
    record.status = 'read';
  }
  return record;
}

/**
 * Update email status (read/unread)
 */
export async function updateEmailStatus(
  kv: KVNamespace,
  tenantId: string,
  id: string,
  status: EmailStatus
): Promise<EmailRecord | null> {
  const record = await getEmailRecord(kv, tenantId, id);
  if (!record) return null;

  record.status = status;
  if (status === 'read' && !record.readAt) {
    record.readAt = new Date().toISOString();
  }

  await kv.put(tenantKey(tenantId, "email", id), JSON.stringify(record), {
    expirationTtl: HISTORY_TTL,
  });

  return record;
}

/**
 * Get recent emails with optional label and status filtering
 */
export async function getRecentEmails(
  kv: KVNamespace,
  tenantId: string,
  limit: number = 20,
  offset: number = 0,
  labelFilter?: string[],
  statusFilter?: EmailStatus
): Promise<{ emails: EmailRecord[]; total: number; unreadCount: number }> {
  // If filtering by labels, use label indexes
  if (labelFilter && labelFilter.length > 0) {
    const emailIds = new Set<string>();

    for (const label of labelFilter) {
      const labelIndex = await getLabelIndex(kv, tenantId, label);
      for (const id of labelIndex) {
        emailIds.add(id);
      }
    }

    const allIds = Array.from(emailIds);

    // Fetch all records for filtering
    let allEmails: EmailRecord[] = [];
    for (const emailId of allIds) {
      const record = await getEmailRecord(kv, tenantId, emailId);
      if (record) allEmails.push(record);
    }

    // Apply status filter if provided
    if (statusFilter) {
      allEmails = allEmails.filter(e => e.status === statusFilter);
    }

    const unreadCount = allEmails.filter(e => e.status === 'unread').length;
    const total = allEmails.length;
    const emails = allEmails.slice(offset, offset + limit);

    return { emails, total, unreadCount };
  }

  // Otherwise use main index
  const index = await getIndex(kv, tenantId);

  // Fetch all records for filtering and counting
  let allEmails: EmailRecord[] = [];
  for (const id of index) {
    const record = await getEmailRecord(kv, tenantId, id);
    if (record) {
      allEmails.push(record);
    }
  }

  // Count unread before filtering
  const unreadCount = allEmails.filter(e => e.status === 'unread').length;

  // Apply status filter if provided
  if (statusFilter) {
    allEmails = allEmails.filter(e => e.status === statusFilter);
  }

  const total = allEmails.length;
  const emails = allEmails.slice(offset, offset + limit);

  return { emails, total, unreadCount };
}

/**
 * Get emails by dispatch success status
 */
export async function getEmailsByStatus(
  kv: KVNamespace,
  tenantId: string,
  success: boolean
): Promise<EmailRecord[]> {
  const { emails } = await getRecentEmails(kv, tenantId, MAX_HISTORY);
  return emails.filter((e) => {
    // Check if any dispatch was successful/failed
    if (success) {
      return e.dispatchResults.some((r) => r.success);
    } else {
      return e.dispatchResults.some((r) => !r.success);
    }
  });
}

/**
 * Get email statistics
 */
export async function getEmailStats(
  kv: KVNamespace,
  tenantId: string
): Promise<{
  total: number;
  byLabel: Record<string, number>;
  successful: number;
  failed: number;
  avgProcessingTimeMs: number;
}> {
  const { emails, total } = await getRecentEmails(kv, tenantId, MAX_HISTORY);

  const byLabel: Record<string, number> = {};
  let successfulCount = 0;
  let failedCount = 0;
  let totalProcessingTime = 0;

  for (const email of emails) {
    totalProcessingTime += email.processingTimeMs;

    // Count by label
    for (const label of email.labels) {
      byLabel[label] = (byLabel[label] || 0) + 1;
    }

    // Count dispatch outcomes
    const hasSuccess = email.dispatchResults.some((r) => r.success);
    const hasFailed = email.dispatchResults.some((r) => !r.success);
    if (hasSuccess) successfulCount++;
    if (hasFailed) failedCount++;
  }

  const avgProcessingTimeMs =
    emails.length > 0 ? Math.round(totalProcessingTime / emails.length) : 0;

  return {
    total,
    byLabel,
    successful: successfulCount,
    failed: failedCount,
    avgProcessingTimeMs,
  };
}

/**
 * Search emails by sender, subject, or labels
 */
export async function searchEmails(
  kv: KVNamespace,
  tenantId: string,
  query: {
    from?: string;
    subject?: string;
    labels?: string[];
  }
): Promise<EmailRecord[]> {
  const { emails } = await getRecentEmails(kv, tenantId, MAX_HISTORY, 0, query.labels);

  return emails.filter((record) => {
    if (query.from && !record.email.from.toLowerCase().includes(query.from.toLowerCase())) {
      return false;
    }
    if (query.subject && !record.email.subject.toLowerCase().includes(query.subject.toLowerCase())) {
      return false;
    }
    return true;
  });
}

// ==================== Index Management ====================

async function getIndex(kv: KVNamespace, tenantId: string): Promise<string[]> {
  const data = await kv.get(tenantKey(tenantId, "email:index"));
  if (!data) return [];
  return JSON.parse(data) as string[];
}

async function addToIndex(kv: KVNamespace, tenantId: string, id: string): Promise<void> {
  const index = await getIndex(kv, tenantId);

  // Add new ID at the beginning (newest first)
  index.unshift(id);

  // Trim to max size
  const trimmed = index.slice(0, MAX_HISTORY);

  await kv.put(tenantKey(tenantId, "email:index"), JSON.stringify(trimmed));
}

async function getLabelIndex(kv: KVNamespace, tenantId: string, label: string): Promise<string[]> {
  const data = await kv.get(tenantKey(tenantId, "label", label, "emails"));
  if (!data) return [];
  return JSON.parse(data) as string[];
}

async function addToLabelIndex(kv: KVNamespace, tenantId: string, label: string, emailId: string): Promise<void> {
  const index = await getLabelIndex(kv, tenantId, label);

  // Add new ID at the beginning (newest first)
  index.unshift(emailId);

  // Trim to max size
  const trimmed = index.slice(0, MAX_HISTORY);

  await kv.put(tenantKey(tenantId, "label", label, "emails"), JSON.stringify(trimmed));
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
