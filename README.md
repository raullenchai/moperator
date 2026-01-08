<p align="center">
  <img src="moperator.png" alt="Moperator Logo" width="400">
</p>

# Moperator

> Email for AI (and non-human Intelligence)

The first email infrastructure built for AI agents, LLMs, and autonomous systems. Moperator routes incoming emails to your AI backends using Claude for intelligent intent classification — because your agents deserve their own inbox.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Inbound   │────▶│  Cloudflare │────▶│   Claude    │────▶│  KV Store   │
│    Email    │     │   Worker    │     │   Haiku     │     │  (instant)  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                           │                   │                   │
                           ▼                   ▼                   ▼
                    ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
                    │ postal-mime │     │  KV Agent   │     │   Webhook   │
                    │   Parser    │     │  Registry   │     │  (optional) │
                    └─────────────┘     └─────────────┘     └─────────────┘
```

## Features

- **Serverless** - Runs on Cloudflare Workers at the edge
- **AI-Powered Routing** - Claude Haiku analyzes content and routes to the right agent
- **Instant Access** - Query emails via MCP (Claude), OpenAPI (ChatGPT), or REST
- **Secure Webhooks** - HMAC-SHA256 signed payloads for real-time dispatch
- **Multi-Protocol** - Native support for ChatGPT, Claude Desktop, and Gemini

## How It Works

1. **Email arrives** at `you@yourdomain.com`
2. **Cloudflare routes** to Moperator Worker
3. **Worker parses** email (postal-mime)
4. **Claude Haiku** decides which agent should handle it
5. **Email stored** in KV (instantly queryable via API)
6. **Webhook fired** to agent (optional, for real-time processing)

## Quick Start

```bash
# Clone and install
git clone https://github.com/yourusername/moperator.git
cd moperator && npm install

# Login to Cloudflare
npx wrangler login

# Create KV namespaces and configure (see docs/DEPLOYMENT.md)
npx wrangler kv namespace create AGENT_REGISTRY
npx wrangler kv namespace create EMAIL_HISTORY

# Set secrets
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put WEBHOOK_SIGNING_KEY

# Deploy
npm run deploy
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for complete setup instructions.

## AI Integrations

Moperator works with your favorite AI assistants out of the box:

| AI Assistant | Protocol | Setup Guide |
|--------------|----------|-------------|
| **ChatGPT** | OpenAPI Actions | [docs/AI_INTEGRATIONS.md#chatgpt](docs/AI_INTEGRATIONS.md#chatgpt-integration-openapi) |
| **Claude Desktop** | MCP | [docs/AI_INTEGRATIONS.md#claude](docs/AI_INTEGRATIONS.md#claude-desktop-integration-mcp) |
| **Gemini** | A2A | [docs/AI_INTEGRATIONS.md#gemini](docs/AI_INTEGRATIONS.md#gemini-integration-a2a) |

Ask your AI: *"Check my email"* or *"How many emails do I have?"*

### TODO: Gemini Consumer Support

> A2A protocol is implemented but Gemini consumer (gemini.google.com) doesn't support A2A yet — only Gemini Enterprise (Google Cloud Vertex AI). The A2A endpoints are ready for when consumer support arrives.

## Documentation

| Document | Description |
|----------|-------------|
| [API Reference](docs/API_REFERENCE.md) | Complete endpoint documentation |
| [Deployment Guide](docs/DEPLOYMENT.md) | Cloudflare setup, KV namespaces, secrets |
| [AI Integrations](docs/AI_INTEGRATIONS.md) | ChatGPT, Claude Desktop, Gemini setup |
| [Webhooks](docs/WEBHOOKS.md) | Payload format and signature verification |
| [Security](docs/SECURITY.md) | Rate limiting, authentication, best practices |

## Development

```bash
# Run locally
npm run dev

# Run tests
npm test

# Type check
npx tsc --noEmit
```

## Project Structure

```
moperator/
├── src/
│   ├── index.ts          # Worker entry point
│   ├── protocols/        # MCP, OpenAPI, A2A implementations
│   ├── router.ts         # Claude routing logic
│   ├── dispatcher.ts     # Webhook dispatch
│   └── __tests__/        # Test files
├── docs/                  # Documentation
├── agent-example/         # Example agent implementation
└── wrangler.toml          # Cloudflare config
```

## License

MIT
