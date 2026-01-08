# Security

Security features and best practices for Moperator deployments.

## API Key Authentication

Sensitive endpoints require API key authentication:

| Endpoint | Description |
|----------|-------------|
| `POST /agents` | Register agent |
| `DELETE /agents/:id` | Delete agent |
| `POST /agents/:id/enable` | Re-enable agent |
| `POST /retry/process` | Trigger retry processing |
| `POST /health/check` | Trigger health checks |
| `POST /test-route` | Test routing (uses Claude API credits) |

### Setting Up Authentication

```bash
# Set the API key secret
npx wrangler secret put API_KEY
```

### Using Authentication

Include the `Authorization` header with all protected requests:

```bash
curl -X POST https://your-deployment.workers.dev/agents \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-bot", "name": "MyBot", "description": "..."}'
```

### Development Mode

If no `API_KEY` secret is configured, authentication is disabled. This is useful for local development but should never be used in production.

## Rate Limiting

All API endpoints are rate-limited to prevent abuse:

| Operation Type | Limit |
|----------------|-------|
| Read (GET) | 60 requests/minute |
| Write (POST/DELETE) | 10 requests/minute |

### Rate Limit Response

When rate limited, you'll receive:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 45
Content-Type: application/json

{"error": "Rate limit exceeded. Try again in 45 seconds."}
```

The `Retry-After` header indicates how many seconds to wait.

### Rate Limit Storage

Rate limits are tracked per IP address using Cloudflare KV. Limits reset after the time window expires.

## Webhook Signatures

Moperator signs all webhook payloads using HMAC-SHA256 to prevent spoofing.

### How It Works

1. When sending a webhook, Moperator computes: `HMAC-SHA256(payload, WEBHOOK_SIGNING_KEY)`
2. The signature is included in the `X-Moperator-Signature` header
3. Your agent verifies the signature using the same key

### Verification Example

```typescript
import { createHmac } from 'crypto';

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return signature === expected;
}
```

See [WEBHOOKS.md](WEBHOOKS.md) for complete examples in multiple languages.

### Key Security

- Generate a strong random key: `openssl rand -hex 32`
- Store securely in Cloudflare secrets
- Share only with trusted agents
- Rotate periodically

## Input Validation

Moperator validates all input to prevent injection attacks:

### Agent Registration

| Field | Validation |
|-------|------------|
| `id` | Alphanumeric, dashes, underscores only |
| `name` | Max 100 characters |
| `description` | Max 500 characters |
| `webhookUrl` | Must be valid URL |

### Query Parameters

| Parameter | Validation |
|-----------|------------|
| `limit` | Number, max 100 |
| `offset` | Number, non-negative |
| `from` | String, sanitized |
| `subject` | String, sanitized |

### Email Processing

| Field | Validation |
|-------|------------|
| `body` | Max 10KB for routing (full body preserved) |
| Attachments | Preserved as-is in webhook payload |

## CORS

API endpoints include CORS headers for browser access:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

For production deployments, consider restricting `Access-Control-Allow-Origin` to specific domains.

## Multi-Tenant Isolation

When using multi-tenant mode:

- Each tenant has a unique API key prefix
- Data is scoped by tenant ID in KV storage
- Tenants cannot access each other's data
- API keys are validated before processing requests

### Tenant Key Format

```
mop_{tenantPrefix}_{randomSecret}
```

Example: `mop_acme_a1b2c3d4e5f6g7h8`

## Security Best Practices

### 1. Always Use HTTPS

Cloudflare Workers automatically use HTTPS. Never disable this.

### 2. Rotate Secrets Regularly

```bash
# Rotate webhook signing key
npx wrangler secret put WEBHOOK_SIGNING_KEY
# Then update all agents with the new key
```

### 3. Use Strong API Keys

Generate cryptographically secure keys:

```bash
openssl rand -base64 32
```

### 4. Monitor for Anomalies

Check logs regularly:

```bash
npx wrangler tail
```

### 5. Limit Agent Permissions

Only register agents that need access. Remove unused agents:

```bash
curl -X DELETE https://your-deployment.workers.dev/agents/old-bot \
  -H "Authorization: Bearer your-api-key"
```

### 6. Validate Webhook Responses

Your agents should:
- Verify signatures on every request
- Validate email content before processing
- Handle errors gracefully
- Log suspicious activity

## Reporting Security Issues

If you discover a security vulnerability, please report it responsibly:

1. Do not create public issues
2. Email security concerns privately
3. Allow time for a fix before disclosure
