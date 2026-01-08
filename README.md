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

## Usage

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
├── wrangler.toml       # Cloudflare Worker configuration
├── tsconfig.json
└── package.json
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key for Claude |
| `WEBHOOK_SIGNING_KEY` | Secret key for HMAC webhook signatures |

## License

MIT
