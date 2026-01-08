# Moperator

> The AI Mail Gateway

A headless, serverless email gateway that routes incoming emails to backend AI agents using Claude for intelligent intent classification.

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

2. **Create a KV namespace:**

```bash
npx wrangler kv namespace create AGENT_REGISTRY
```

3. **Update `wrangler.toml`** with the returned namespace ID:

```toml
[[kv_namespaces]]
binding = "AGENT_REGISTRY"
id = "your-namespace-id-here"
```

4. **Set secrets:**

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put WEBHOOK_SIGNING_KEY
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

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/agents` | List all registered agents |
| `POST` | `/agents` | Register a new agent |
| `DELETE` | `/agents/:id` | Delete an agent |
| `POST` | `/test-route` | Test email routing (dev/debug) |

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
│   ├── index.ts        # Worker entry point (email + HTTP handlers)
│   ├── types.ts        # TypeScript interfaces
│   ├── email-parser.ts # MIME parsing with postal-mime
│   ├── router.ts       # Claude routing logic
│   └── dispatcher.ts   # Webhook dispatch with HMAC signing
├── agent-example/      # Example agent implementation
│   ├── server.js       # Express server with webhook handler
│   └── README.md       # Agent setup instructions
├── wrangler.toml       # Cloudflare Worker configuration
├── vitest.config.ts    # Test configuration
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

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key for Claude |
| `WEBHOOK_SIGNING_KEY` | Secret key for HMAC webhook signatures |

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
