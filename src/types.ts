// Environment bindings
export interface Env {
  AGENT_REGISTRY: KVNamespace;
  ANTHROPIC_API_KEY: string;
  WEBHOOK_SIGNING_KEY: string;
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
