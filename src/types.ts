// Environment bindings
export interface Env {
  AGENT_REGISTRY: KVNamespace;
  EMAIL_HISTORY: KVNamespace;
  RETRY_QUEUE: KVNamespace;
  RATE_LIMIT: KVNamespace;
  TENANTS: KVNamespace;        // Multi-tenant user data
  ANTHROPIC_API_KEY: string;
  WEBHOOK_SIGNING_KEY: string;
  API_KEY?: string;            // Admin API key for system management
  ADMIN_SECRET?: string;       // Admin secret for tenant management
}

// Label defined by tenant for email classification
export interface Label {
  id: string;           // "finance", "travel", etc. (alphanumeric + dash, max 50 chars)
  name: string;         // "Finance & Bills" (display name, max 100 chars)
  description: string;  // For Claude: "Invoices, receipts, bank statements" (max 500 chars)
}

// Default labels for new tenants
export const DEFAULT_LABELS: Label[] = [
  { id: "important", name: "Important", description: "Urgent, time-sensitive, or high-priority emails requiring immediate attention" },
  { id: "catch-all", name: "Other", description: "Emails that don't fit other categories" },
];

// Maximum labels per tenant
export const MAX_LABELS_PER_TENANT = 50;

// Agent registered in KV - now subscribes to labels
export interface Agent {
  id: string;
  name: string;
  description: string;
  webhookUrl?: string;         // Optional - agent may not need webhook
  labels: string[];            // Labels this agent subscribes to
  active: boolean;
}

// Parsed email data
export interface ParsedEmail {
  from: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  attachments: Attachment[];
  receivedAt: string;
}

export interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
  content: string; // base64 encoded
}

// Webhook payload sent to agents
export interface WebhookPayload {
  email: ParsedEmail;
  labels: string[];            // Labels assigned to this email
  matchedLabel: string;        // Which label triggered this webhook
  routingReason: string;
  timestamp: string;
  signature: string;
}

// Claude API types
export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ClaudeResponse {
  content: Array<{ type: "text"; text: string }>;
}

// Labeling decision from Claude (replaces RoutingDecision)
export interface LabelingDecision {
  labels: string[];    // One or more labels assigned
  reason: string;      // Explanation for the labeling
}

// Legacy: Routing decision (kept for backwards compatibility)
export interface RoutingDecision {
  agentId: string;
  reason: string;
}

// Email status
export type EmailStatus = 'unread' | 'read';

// Email history record - now with labels
export interface EmailRecord {
  id: string;
  email: ParsedEmail;
  labels: string[];                    // Labels assigned to this email
  labelingDecision: LabelingDecision;  // Full decision from Claude
  dispatchResults: DispatchResult[];   // Results for each agent notified
  processedAt: string;
  processingTimeMs: number;
  status: EmailStatus;                 // Read/unread status
  readAt?: string;                     // When email was first read
}

// Retry queue item - updated for label-based dispatch
export interface RetryItem {
  id: string;
  email: ParsedEmail;
  agentId: string;
  webhookUrl: string;
  labels: string[];           // Labels on the email
  matchedLabel: string;       // Which label triggered this agent
  routingReason: string;
  attempts: number;
  maxAttempts: number;
  lastAttempt: string;
  nextAttempt: string;
  lastError?: string;
  createdAt: string;
}

// Dispatch result with more details
export interface DispatchResult {
  agentId: string;
  matchedLabel: string;     // Which label triggered this dispatch
  success: boolean;
  statusCode?: number;
  error?: string;
}
