# API Reference

Complete API documentation for Moperator endpoints.

## Authentication

Sensitive endpoints require API key authentication. Include the `Authorization` header:

```bash
curl -X POST https://your-deployment.workers.dev/agents \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-bot", ...}'
```

If no `API_KEY` secret is configured, authentication is disabled (dev mode).

---

## Health

### GET /health

Health check endpoint.

```bash
curl https://your-deployment.workers.dev/health
```

```json
{ "status": "ok", "service": "moperator" }
```

---

## Agent Management

### GET /agents

List all registered agents.

```bash
curl https://your-deployment.workers.dev/agents
```

### POST /agents

Register a new agent. **Requires authentication.**

```bash
curl -X POST https://your-deployment.workers.dev/agents \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "finance-bot",
    "name": "FinanceBot",
    "description": "Handles invoices, receipts, expense reports, and financial documents",
    "webhookUrl": "https://your-server.com/webhooks/finance"
  }'
```

**Request body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier (alphanumeric, dashes, underscores) |
| `name` | string | Yes | Display name (max 100 chars) |
| `description` | string | Yes | What this agent handles (max 500 chars) |
| `webhookUrl` | string | No | Webhook URL for email dispatch |

### DELETE /agents/:id

Delete an agent. **Requires authentication.**

```bash
curl -X DELETE https://your-deployment.workers.dev/agents/finance-bot \
  -H "Authorization: Bearer your-api-key"
```

### POST /agents/:id/enable

Re-enable a disabled agent. **Requires authentication.**

```bash
curl -X POST https://your-deployment.workers.dev/agents/finance-bot/enable \
  -H "Authorization: Bearer your-api-key"
```

---

## Email History

### GET /emails

List recent emails with pagination.

```bash
curl "https://your-deployment.workers.dev/emails?limit=10&offset=0"
```

**Query parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 10 | Max emails to return (max: 100) |
| `offset` | number | 0 | Skip this many emails |

### GET /emails/:id

Get a single email record by ID.

```bash
curl https://your-deployment.workers.dev/emails/email-abc123
```

### GET /emails/search

Search emails by sender or subject.

```bash
curl "https://your-deployment.workers.dev/emails/search?from=vendor@company.com"
curl "https://your-deployment.workers.dev/emails/search?subject=invoice"
curl "https://your-deployment.workers.dev/emails/search?agentId=finance-bot"
```

**Query parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `from` | string | Filter by sender (partial match) |
| `subject` | string | Filter by subject (partial match) |
| `agentId` | string | Filter by routed agent ID |

### GET /emails/stats

Get email processing statistics.

```bash
curl https://your-deployment.workers.dev/emails/stats
```

```json
{
  "total": 42,
  "successful": 38,
  "failed": 4,
  "avgProcessingTimeMs": 1250
}
```

---

## Agent Health

### GET /health/agents

Get health status for all agents.

```bash
curl https://your-deployment.workers.dev/health/agents
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

### POST /health/check

Trigger health check for all agents. **Requires authentication.**

```bash
curl -X POST https://your-deployment.workers.dev/health/check \
  -H "Authorization: Bearer your-api-key"
```

### POST /health/agents/:id

Check health of a specific agent. **Requires authentication.**

```bash
curl -X POST https://your-deployment.workers.dev/health/agents/finance-bot \
  -H "Authorization: Bearer your-api-key"
```

---

## Retry Queue

### GET /retry/stats

Get retry queue statistics.

```bash
curl https://your-deployment.workers.dev/retry/stats
```

```json
{
  "pending": 2,
  "deadLettered": 1
}
```

### GET /retry/pending

List pending retry items.

```bash
curl https://your-deployment.workers.dev/retry/pending
```

### GET /retry/dead

List dead letter items (failed after max retries).

```bash
curl https://your-deployment.workers.dev/retry/dead
```

### POST /retry/process

Manually trigger retry processing. **Requires authentication.**

```bash
curl -X POST https://your-deployment.workers.dev/retry/process \
  -H "Authorization: Bearer your-api-key"
```

---

## Testing

### POST /test-route

Test email routing without sending an actual email. **Requires authentication.**

```bash
curl -X POST https://your-deployment.workers.dev/test-route \
  -H "Authorization: Bearer your-api-key" \
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

---

## AI Protocol Endpoints

For AI assistants (ChatGPT, Claude Desktop, Gemini), Moperator exposes protocol-specific endpoints.

See [AI_INTEGRATIONS.md](AI_INTEGRATIONS.md) for setup instructions.

| Protocol | Endpoint | Description |
|----------|----------|-------------|
| OpenAPI | `GET /openapi.json` | OpenAPI 3.1.0 spec for ChatGPT |
| MCP | `POST /mcp` | Model Context Protocol for Claude Desktop |
| A2A | `GET /.well-known/agent.json` | Agent Card for Gemini |
| A2A | `GET /a2a/capabilities` | List A2A capabilities |
| A2A | `POST /a2a/tasks` | Execute A2A task |

---

## Error Responses

All endpoints return errors in a consistent format:

```json
{
  "error": "Error message describing what went wrong"
}
```

**Common HTTP status codes:**
| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Missing or invalid API key |
| 404 | Not Found - Resource doesn't exist |
| 429 | Too Many Requests - Rate limited |
| 500 | Internal Server Error |
