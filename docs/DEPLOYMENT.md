# Deployment Guide

Step-by-step guide to deploy Moperator on Cloudflare Workers.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Anthropic API key](https://console.anthropic.com/)
- A domain configured in Cloudflare (for email routing)

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/moperator.git
cd moperator

# Install dependencies
npm install
```

## Cloudflare Setup

### 1. Login to Cloudflare

```bash
npx wrangler login
```

### 2. Create KV Namespaces

Moperator uses four KV namespaces:

```bash
npx wrangler kv namespace create AGENT_REGISTRY
npx wrangler kv namespace create EMAIL_HISTORY
npx wrangler kv namespace create RETRY_QUEUE
npx wrangler kv namespace create RATE_LIMIT
```

Each command returns an ID. Note these for the next step.

### 3. Configure wrangler.toml

Update `wrangler.toml` with your namespace IDs:

```toml
name = "moperator"
main = "src/index.ts"
compatibility_date = "2024-01-01"

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

### 4. Set Secrets

```bash
# Required: Anthropic API key for Claude routing
npx wrangler secret put ANTHROPIC_API_KEY

# Required: Secret for signing webhook payloads
npx wrangler secret put WEBHOOK_SIGNING_KEY

# Optional: API key for protecting management endpoints
npx wrangler secret put API_KEY
```

**Generate a secure webhook signing key:**
```bash
openssl rand -hex 32
```

### 5. Deploy

```bash
npm run deploy
```

Your worker will be available at `https://moperator.your-subdomain.workers.dev`

## Email Routing Setup

### Configure Cloudflare Email Routing

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Select your domain
3. Navigate to **Email** → **Email Routing**
4. Enable Email Routing if not already enabled
5. Add DNS records when prompted

### Create Email Route

1. In Email Routing, click **Routing Rules**
2. Create a catch-all route or specific address:
   - **Catch-all**: `*@yourdomain.com` → Worker → `moperator`
   - **Specific**: `inbox@yourdomain.com` → Worker → `moperator`
3. Save the route

Now emails sent to your configured address will be processed by Moperator.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key for Claude |
| `WEBHOOK_SIGNING_KEY` | Yes | Secret for HMAC webhook signatures |
| `API_KEY` | No | Protects management endpoints |

### About WEBHOOK_SIGNING_KEY

This secret signs webhook payloads so your agents can verify requests came from Moperator:

1. Moperator signs each payload with HMAC-SHA256 using this key
2. The signature is sent in the `X-Moperator-Signature` header
3. Your agent verifies the signature using the same key

Share this key with your agents so they can verify incoming webhooks.

## Custom Domain (Optional)

To use a custom domain like `api.yourdomain.com`:

1. In Cloudflare Workers, go to your worker
2. Click **Triggers** → **Custom Domains**
3. Add your domain (must be on Cloudflare)

## Development Mode

For local development:

```bash
npm run dev
```

This starts a local Cloudflare Workers environment at `http://localhost:8787`.

Note: Email routing only works in production. Use the `/test-route` endpoint for local testing.

## Verifying Deployment

```bash
# Check health
curl https://your-deployment.workers.dev/health

# Should return:
# { "status": "ok", "service": "moperator" }
```

## Troubleshooting

### "KV namespace not found"
- Ensure namespace IDs in `wrangler.toml` match what was returned when creating them
- Run `npx wrangler kv namespace list` to see all namespaces

### "Missing ANTHROPIC_API_KEY"
- Set the secret: `npx wrangler secret put ANTHROPIC_API_KEY`
- Verify: `npx wrangler secret list`

### Emails not being routed
- Check Email Routing is enabled in Cloudflare
- Verify the route points to the correct worker
- Check worker logs: `npx wrangler tail`

### Webhook timeouts
- Cloudflare Workers have a 30-second execution limit
- Ensure your webhook endpoints respond quickly
- Check agent health: `GET /health/agents`
