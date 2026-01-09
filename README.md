<p align="center">
  <img src="moperator.png" alt="Moperator Logo" width="400">
</p>

# Moperator

> Email for AI (and non-human Intelligence)

The first email infrastructure built for AI agents, LLMs, and autonomous systems. Moperator uses Claude to intelligently label incoming emails, making them instantly queryable by ChatGPT, Claude Desktop, Gemini, or your custom agents.

## Architecture

```
Email Arrives → Parse → Claude Labels → Store in KV
                                            ↓
                    ┌───────────────────────┴───────────────────────┐
                    ↓                                               ↓
              AI Assistants (Pull)                         Custom Agents (Push+Pull)
         ChatGPT / Claude / Gemini                         Webhook on arrival
         Query: GET /emails?labels=finance                 + Query API anytime
```

## Features

- **Serverless** - Runs on Cloudflare Workers at the edge
- **AI-Powered Labeling** - Claude Haiku classifies emails based on your label definitions
- **Read/Unread Status** - Track email status with auto-mark on read support
- **Pull-Based Access** - Query emails via MCP (Claude), OpenAPI (ChatGPT), or REST API
- **Push Notifications** - Optional webhooks for custom agents that need real-time alerts
- **Multi-Protocol** - Native support for ChatGPT, Claude Desktop, Gemini, and REST
- **Label-Based Integrations** - Scope each integration to specific labels

## How It Works

1. **Email arrives** at `yourbot@moperator.work`
2. **Cloudflare routes** to Moperator Worker
3. **Worker parses** email (postal-mime)
4. **Claude Haiku** assigns labels based on your definitions
5. **Email stored** in KV with labels (instantly queryable)
6. **Webhook fired** to subscribed agents (optional, for real-time)

## Integration Models

| Integration | Model | Description |
|-------------|-------|-------------|
| **ChatGPT** | Pull | Query emails via OpenAPI Actions |
| **Claude Desktop** | Pull | Access emails via MCP tools |
| **Gemini** | Pull | A2A protocol capabilities |
| **Custom Agents** | Push + Pull | Webhooks AND/OR API queries |

### Custom Agent Modes
- **Pull-only:** No webhook, agent queries API on its schedule
- **Push + Pull:** Agent receives webhooks on email arrival, can also query anytime

## Quick Start

```bash
# Clone and install
git clone https://github.com/anthropics/moperator.git
cd moperator && npm install

# Login to Cloudflare
npx wrangler login

# Create KV namespaces
npx wrangler kv namespace create AGENT_REGISTRY
npx wrangler kv namespace create EMAIL_HISTORY
npx wrangler kv namespace create TENANTS
npx wrangler kv namespace create RETRY_QUEUE

# Set secrets
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put WEBHOOK_SIGNING_KEY
npx wrangler secret put ADMIN_API_KEY

# Deploy
npm run deploy
```

## Define Labels

Labels help Claude classify your emails. Define them via API or dashboard:

```bash
curl -X POST https://your-worker.workers.dev/api/v1/labels \
  -H "Authorization: Bearer mop_yourkey" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "finance",
    "name": "Finance & Bills",
    "description": "Invoices, receipts, bank statements, payment confirmations"
  }'
```

Claude uses your descriptions to decide which labels apply to each email.

## Query Emails

```bash
# Get all emails (returns unreadCount in response)
curl https://your-worker.workers.dev/api/v1/emails \
  -H "Authorization: Bearer mop_yourkey"

# Filter by label
curl "https://your-worker.workers.dev/api/v1/emails?labels=finance" \
  -H "Authorization: Bearer mop_yourkey"

# Filter by status (unread/read)
curl "https://your-worker.workers.dev/api/v1/emails?status=unread" \
  -H "Authorization: Bearer mop_yourkey"

# Get single email (without marking as read)
curl "https://your-worker.workers.dev/api/v1/emails/EMAIL_ID" \
  -H "Authorization: Bearer mop_yourkey"

# Get single email AND mark as read
curl "https://your-worker.workers.dev/api/v1/emails/EMAIL_ID?markRead=true" \
  -H "Authorization: Bearer mop_yourkey"

# Mark email as read/unread
curl -X PATCH "https://your-worker.workers.dev/api/v1/emails/EMAIL_ID" \
  -H "Authorization: Bearer mop_yourkey" \
  -H "Content-Type: application/json" \
  -d '{"status": "read"}'

# Search
curl "https://your-worker.workers.dev/api/v1/emails/search?from=bank" \
  -H "Authorization: Bearer mop_yourkey"
```

## AI Integrations

| AI Assistant | Protocol | How to Connect |
|--------------|----------|----------------|
| **ChatGPT** | OpenAPI | Import `https://your-worker.workers.dev/openapi.json` as GPT Action |
| **Claude Desktop** | MCP | Add to `claude_desktop_config.json` (see below) |
| **Gemini** | A2A | `/.well-known/agent.json` endpoint |

### Claude Desktop Setup

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "moperator": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://api.moperator.work/mcp", "--header", "Authorization: Bearer mop_yourkey"]
    }
  }
}
```

Then ask Claude: *"Check my email"* or *"Do I have any finance emails?"*

## Email Status

Emails have read/unread status:
- **New emails** arrive as `unread`
- **Dashboard** shows unread count badge and visual indicators (blue dot, bold text)
- **Auto-mark as read:** Append `?markRead=true` when fetching email detail
- **Manual update:** Use `PATCH /api/v1/emails/:id` with `{"status": "read"}` or `{"status": "unread"}`

AI agents can choose whether to mark emails as read when accessing them.

## Dashboard

A web dashboard is available at [app.moperator.work](https://app.moperator.work) for managing labels, agents, and viewing emails.

To self-host the dashboard, deploy the `app/` folder to Cloudflare Pages:
```bash
npx wrangler pages deploy app --project-name moperator-app
```

## Development

```bash
# Run locally
npm run dev

# Run tests
npm test

# Run tests with coverage
npm test -- --coverage

# Type check
npx tsc --noEmit
```

## Project Structure

```
moperator/
├── src/
│   ├── index.ts          # Worker entry point, API routes
│   ├── tenant.ts         # Multi-tenant auth, signup/login
│   ├── labels.ts         # Label CRUD operations
│   ├── labeler.ts        # Claude labeling logic
│   ├── email-history.ts  # Email storage and status
│   ├── dispatcher.ts     # Webhook dispatch (for custom agents)
│   ├── types.ts          # TypeScript interfaces
│   ├── protocols/        # MCP, OpenAPI, A2A implementations
│   └── __tests__/        # Test files
├── app/                  # Dashboard (Cloudflare Pages)
│   └── index.html        # Single-page app (Alpine.js + Tailwind)
├── wrangler.toml         # Cloudflare config
├── CLAUDE.md             # Detailed project documentation
└── README.md             # This file
```

## License

MIT
