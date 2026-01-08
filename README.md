<p align="center">
  <img src="moperator.png" alt="Moperator Logo" width="400">
</p>

# Moperator

> Email for AI (and non-human Intelligence)

The first email infrastructure built for AI agents, LLMs, and autonomous systems. Moperator routes incoming emails to your AI backends using Claude for intelligent intent classification — because your agents deserve their own inbox.

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Inbound   │────▶│  Cloudflare │────▶│   Claude    │────▶│   Agent     │
│    Email    │     │   Worker    │     │   Haiku     │     │   Webhook   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                           │                   │
                           ▼                   ▼
                    ┌─────────────┐     ┌─────────────┐
                    │ postal-mime │     │  KV Agent   │
                    │   Parser    │     │  Registry   │
                    └─────────────┘     └─────────────┘
```

## Features

- **Serverless**: Runs on Cloudflare Workers at the edge
- **AI-Powered Routing**: Claude Haiku analyzes email content and routes to the appropriate agent
- **Secure Webhooks**: HMAC-SHA256 signed payloads for webhook verification
- **Agent Registry**: Dynamic agent management via KV storage and REST API
- **Email Parsing**: Full MIME parsing including attachments via postal-mime

## How It Works

```
Email sent to you@yourdomain.com
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                   Cloudflare Email Routing                  │
│                 (routes to Moperator Worker)                │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                     Moperator Worker                        │
│  1. Parse email (postal-mime)                               │
│  2. Fetch registered agents from KV                         │
│  3. Call Claude Haiku API for routing decision              │
│  4. Dispatch to selected agent's webhook                    │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Claude 3.5 Haiku                         │
│                                                             │
│  Prompt: "Here's an email. Here are the available agents:  │
│           - finance-bot: Handles invoices...                │
│           - support-bot: Handles customer inquiries...      │
│           Which agent should handle this?"                  │
│                                                             │
│  Response: {"agentId": "finance-bot",                       │
│             "reason": "Email contains invoice"}             │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                      Your Agent                             │
│  - Receives webhook with parsed email                       │
│  - Verifies HMAC signature                                  │
│  - Processes email (e.g., analyze with Claude, save, etc.)  │
└─────────────────────────────────────────────────────────────┘
```

### Routing Logic

The Moperator Worker calls **Claude 3.5 Haiku** via the Anthropic API to make intelligent routing decisions:

1. Worker receives email and parses it
2. Fetches all registered agents from Cloudflare KV
3. Sends prompt to Claude Haiku with:
   - Email details (from, subject, body preview)
   - List of agents with their descriptions
4. Claude returns the best-matching agent ID and reason
5. Worker dispatches the email to that agent's webhook

This allows routing based on email **content and intent**, not just simple rules.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Anthropic API key](https://console.anthropic.com/)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/moperator.git
cd moperator

# Install dependencies
npm install
```

### Configuration

Wrangler CLI is included as a dev dependency. Use `npx wrangler` to run commands.

1. **Login to Cloudflare:**

```bash
npx wrangler login
```

2. **Create KV namespaces:**

```bash
npx wrangler kv namespace create AGENT_REGISTRY
npx wrangler kv namespace create EMAIL_HISTORY
npx wrangler kv namespace create RETRY_QUEUE
npx wrangler kv namespace create RATE_LIMIT
```

3. **Update `wrangler.toml`** with the returned namespace IDs:

```toml
[[kv_namespaces]]
binding = "AGENT_REGISTRY"
id = "your-agent-registry-id"

[[kv_namespaces]]
binding = "EMAIL_HISTORY"
id = "your-email-history-id"

[[kv_namespaces]]
binding = "RETRY_QUEUE"
id = "your-retry-queue-id"

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "your-rate-limit-id"
```

4. **Set secrets:**

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put WEBHOOK_SIGNING_KEY
npx wrangler secret put API_KEY  # Optional: for API authentication
```

### Deployment

```bash
npm run deploy
```

### Email Routing Setup

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → Email → Email Routing
2. Add your domain if not already configured
3. Create a route: `*@yourdomain.com` → Worker → `moperator`

## API Reference

### Agent Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/agents` | List all registered agents |
| `POST` | `/agents` | Register a new agent |
| `DELETE` | `/agents/:id` | Delete an agent |
| `POST` | `/test-route` | Test email routing (dev/debug) |

### Email History

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/emails` | List recent emails (supports `?limit=20&offset=0`) |
| `GET` | `/emails/stats` | Get processing statistics |
| `GET` | `/emails/search` | Search emails (`?from=&subject=&agentId=`) |
| `GET` | `/emails/:id` | Get single email record by ID |

### Retry Queue

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/retry/stats` | Get retry queue statistics |
| `GET` | `/retry/pending` | List pending retry items |
| `GET` | `/retry/dead` | List dead letter items (failed after max retries) |
| `POST` | `/retry/process` | Manually trigger retry processing |

### Health Checks

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health/agents` | Get health status for all agents |
| `POST` | `/health/check` | Trigger health check for all agents |
| `POST` | `/health/agents/:id` | Check health of specific agent |
| `POST` | `/agents/:id/enable` | Re-enable a disabled agent |

### Health Check

```bash
curl https://moperator.your-subdomain.workers.dev/health
```

```json
{ "status": "ok", "service": "moperator" }
```

### Register an Agent

```bash
curl -X POST https://moperator.your-subdomain.workers.dev/agents \
  -H "Content-Type: application/json" \
  -d '{
    "id": "finance-bot",
    "name": "FinanceBot",
    "description": "Handles invoices, receipts, expense reports, and financial documents",
    "webhookUrl": "https://your-server.com/webhooks/finance"
  }'
```

### List Agents

```bash
curl https://moperator.your-subdomain.workers.dev/agents
```

### Delete an Agent

```bash
curl -X DELETE https://moperator.your-subdomain.workers.dev/agents/finance-bot
```

### Test Routing

Simulate email routing without sending an actual email. Useful for testing and debugging.

```bash
curl -X POST https://moperator.your-subdomain.workers.dev/test-route \
  -H "Content-Type: application/json" \
  -d '{
    "from": "vendor@company.com",
    "subject": "Invoice #1234",
    "body": "Please find attached the invoice for Q4 services."
  }'
```

```json
{
  "email": {
    "from": "vendor@company.com",
    "to": "inbox@moperator.ai",
    "subject": "Invoice #1234",
    "textBody": "Please find attached the invoice for Q4 services.",
    "attachments": [],
    "receivedAt": "2024-01-15T10:30:00.000Z"
  },
  "routing": {
    "agentId": "finance-bot",
    "reason": "Email contains an invoice for financial services"
  },
  "availableAgents": [
    { "id": "finance-bot", "name": "FinanceBot" },
    { "id": "support-bot", "name": "SupportBot" }
  ]
}
```

### Email History

```bash
# Get processing statistics
curl https://moperator.your-subdomain.workers.dev/emails/stats
```

```json
{
  "total": 42,
  "successful": 38,
  "failed": 4,
  "avgProcessingTimeMs": 1250
}
```

```bash
# List recent emails with pagination
curl "https://moperator.your-subdomain.workers.dev/emails?limit=10&offset=0"
```

```bash
# Search emails by sender or subject
curl "https://moperator.your-subdomain.workers.dev/emails/search?from=vendor@company.com"
```

### Retry Queue

```bash
# Get retry queue statistics
curl https://moperator.your-subdomain.workers.dev/retry/stats
```

```json
{
  "pending": 2,
  "deadLettered": 1
}
```

```bash
# List pending retries
curl https://moperator.your-subdomain.workers.dev/retry/pending

# List dead letter items (failed after 5 attempts)
curl https://moperator.your-subdomain.workers.dev/retry/dead

# Manually trigger retry processing
curl -X POST https://moperator.your-subdomain.workers.dev/retry/process
```

### Health Checks

```bash
# Get health status for all agents
curl https://moperator.your-subdomain.workers.dev/health/agents
```

```json
{
  "agents": [
    {
      "id": "finance-bot",
      "name": "FinanceBot",
      "active": true,
      "health": {
        "healthy": true,
        "lastCheck": "2024-01-15T10:30:00.000Z",
        "lastSuccess": "2024-01-15T10:30:00.000Z",
        "consecutiveFailures": 0,
        "responseTimeMs": 234
      }
    }
  ],
  "summary": {
    "total": 2,
    "active": 2,
    "healthy": 2,
    "unhealthy": 0
  }
}
```

```bash
# Manually trigger health check for all agents
curl -X POST https://moperator.your-subdomain.workers.dev/health/check \
  -H "Authorization: Bearer your-api-key"

# Check health of a specific agent
curl -X POST https://moperator.your-subdomain.workers.dev/health/agents/finance-bot \
  -H "Authorization: Bearer your-api-key"

# Re-enable a disabled agent (after fixing the webhook)
curl -X POST https://moperator.your-subdomain.workers.dev/agents/finance-bot/enable \
  -H "Authorization: Bearer your-api-key"
```

**Auto-disable behavior:** Agents are automatically disabled after 3 consecutive health check failures. Use the `/agents/:id/enable` endpoint to re-enable them after fixing the issue.

## Webhook Payload

When an email is routed to an agent, the webhook receives:

```json
{
  "email": {
    "from": "sender@example.com",
    "to": "inbox@yourdomain.com",
    "subject": "Invoice #1234",
    "textBody": "Please find attached...",
    "htmlBody": "<html>...</html>",
    "attachments": [
      {
        "filename": "invoice.pdf",
        "mimeType": "application/pdf",
        "size": 12345,
        "content": "base64-encoded-content"
      }
    ],
    "receivedAt": "2024-01-15T10:30:00.000Z"
  },
  "routedTo": "finance-bot",
  "routingReason": "Email contains invoice and financial document",
  "timestamp": "2024-01-15T10:30:01.000Z",
  "signature": "hmac-sha256-signature"
}
```

### Verifying Webhook Signatures

```typescript
import { createHmac } from 'crypto';

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return signature === expected;
}

// In your webhook handler:
app.post('/webhook', (req, res) => {
  const signature = req.headers['x-moperator-signature'];
  const payload = JSON.stringify(req.body);

  if (!verifySignature(payload, signature, process.env.WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Process the email...
});
```

## Development

```bash
# Run locally
npm run dev

# Type check
npx tsc --noEmit

# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

## Project Structure

```
moperator/
├── src/
│   ├── index.ts          # Worker entry point (email + HTTP handlers)
│   ├── types.ts          # TypeScript interfaces
│   ├── email-parser.ts   # MIME parsing with postal-mime
│   ├── router.ts         # Claude routing logic
│   ├── dispatcher.ts     # Webhook dispatch with HMAC signing
│   ├── email-history.ts  # Email history storage
│   ├── retry-queue.ts    # Webhook retry queue with exponential backoff
│   ├── rate-limiter.ts   # Rate limiting middleware
│   ├── auth.ts           # API key authentication
│   └── __tests__/        # Test files
├── agent-example/        # Example agent implementation
│   ├── server.js         # Express server with webhook handler
│   └── README.md         # Agent setup instructions
├── wrangler.toml         # Cloudflare Worker configuration
├── vitest.config.ts      # Test configuration
├── tsconfig.json
└── package.json
```

## Example Agent

The `agent-example/` directory contains a simple agent that:
- Receives webhooks from Moperator
- Verifies HMAC signatures
- Analyzes emails using Claude

To run it:

```bash
cd agent-example
npm install
WEBHOOK_SECRET="your-key" ANTHROPIC_API_KEY="sk-ant-..." npm start
```

Then expose it publicly with cloudflared or ngrok and register it as an agent.

See [agent-example/README.md](agent-example/README.md) for details.

## Security

### Rate Limiting

All API endpoints are rate-limited to prevent abuse:

| Operation Type | Limit |
|----------------|-------|
| Read (GET) | 60 requests/minute |
| Write (POST/DELETE) | 10 requests/minute |

When rate limited, you'll receive a `429 Too Many Requests` response with a `Retry-After` header.

### API Key Authentication

Sensitive endpoints require API key authentication:

- `POST /agents` - Register agent
- `DELETE /agents/:id` - Delete agent
- `POST /retry/process` - Trigger retry processing
- `POST /test-route` - Test routing (consumes Claude API credits)

To authenticate, include the `Authorization` header:

```bash
curl -X POST https://moperator.your-subdomain.workers.dev/agents \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-bot", ...}'
```

If no `API_KEY` secret is configured, authentication is disabled (dev mode).

### Input Validation

- Agent IDs: alphanumeric, dashes, and underscores only
- Webhook URLs: must be valid URLs
- Field lengths: name (100 chars), description (500 chars), body (10KB)
- Pagination: limit capped at 100, offset must be non-negative

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key for Claude |
| `WEBHOOK_SIGNING_KEY` | Secret key for HMAC webhook signatures |
| `API_KEY` | (Optional) API key for protecting management endpoints |

### About WEBHOOK_SIGNING_KEY

This secret is used to sign webhook payloads so your agents can verify requests actually came from Moperator (preventing spoofed requests).

**Generate a secure key:**
```bash
openssl rand -hex 32
```

**How it works:**
1. Moperator signs each payload with HMAC-SHA256 using this key
2. The signature is sent in the `X-Moperator-Signature` header
3. Your agent verifies the signature using the same key (see [Verifying Webhook Signatures](#verifying-webhook-signatures))

You must share this key with your agents so they can verify incoming webhooks.

## License

MIT
