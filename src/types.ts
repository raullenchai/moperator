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

// Agent registered in KV
export interface Agent {
  id: string;
  name: string;
  description: string;
  webhookUrl: string;
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
  routedTo: string;
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

// Routing decision from Claude
export interface RoutingDecision {
  agentId: string;
  reason: string;
}

// Email history record
export interface EmailRecord {
  id: string;
  email: ParsedEmail;
  routingDecision: RoutingDecision;
  dispatchResult: {
    success: boolean;
    statusCode?: number;
    error?: string;
  };
  agentId: string;
  processedAt: string;
  processingTimeMs: number;
}

// Retry queue item
export interface RetryItem {
  id: string;
  email: ParsedEmail;
  agentId: string;
  webhookUrl: string;
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
  success: boolean;
  statusCode?: number;
  error?: string;
}
