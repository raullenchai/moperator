# Webhook Integration

When Moperator routes an email to an agent with a configured webhook URL, it sends a signed HTTP POST request.

## Payload Format

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

### Email Fields

| Field | Type | Description |
|-------|------|-------------|
| `from` | string | Sender email address |
| `to` | string | Recipient email address |
| `subject` | string | Email subject line |
| `textBody` | string | Plain text content |
| `htmlBody` | string | HTML content (if available) |
| `attachments` | array | List of attachments |
| `receivedAt` | string | ISO timestamp when received |

### Attachment Fields

| Field | Type | Description |
|-------|------|-------------|
| `filename` | string | Original filename |
| `mimeType` | string | MIME type (e.g., `application/pdf`) |
| `size` | number | Size in bytes |
| `content` | string | Base64-encoded content |

## Signature Verification

Moperator signs every webhook payload using HMAC-SHA256. The signature is sent in the `X-Moperator-Signature` header.

**Always verify the signature** to ensure the request came from Moperator.

### Node.js / TypeScript

```typescript
import { createHmac } from 'crypto';

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return signature === expected;
}

// Express example
app.post('/webhook', (req, res) => {
  const signature = req.headers['x-moperator-signature'] as string;
  const payload = JSON.stringify(req.body);

  if (!verifySignature(payload, signature, process.env.WEBHOOK_SECRET!)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Process the email...
  const { email, routedTo, routingReason } = req.body;
  console.log(`Email from ${email.from}: ${email.subject}`);

  res.json({ success: true });
});
```

### Python

```python
import hmac
import hashlib

def verify_signature(payload: str, signature: str, secret: str) -> bool:
    expected = hmac.new(
        secret.encode(),
        payload.encode(),
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)

# Flask example
@app.route('/webhook', methods=['POST'])
def webhook():
    signature = request.headers.get('X-Moperator-Signature')
    payload = request.get_data(as_text=True)

    if not verify_signature(payload, signature, os.environ['WEBHOOK_SECRET']):
        return jsonify({'error': 'Invalid signature'}), 401

    data = request.get_json()
    print(f"Email from {data['email']['from']}: {data['email']['subject']}")

    return jsonify({'success': True})
```

### Go

```go
import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
)

func verifySignature(payload, signature, secret string) bool {
    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write([]byte(payload))
    expected := hex.EncodeToString(mac.Sum(nil))
    return hmac.Equal([]byte(signature), []byte(expected))
}
```

## Retry Behavior

If your webhook fails (non-2xx response or timeout), Moperator will retry with exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 15 minutes |
| 5 | 1 hour |

After 5 failed attempts, the email is moved to the dead letter queue.

### Monitoring Retries

```bash
# Check pending retries
curl https://your-deployment.workers.dev/retry/pending

# Check dead letter queue
curl https://your-deployment.workers.dev/retry/dead

# Manually trigger retry processing
curl -X POST https://your-deployment.workers.dev/retry/process \
  -H "Authorization: Bearer your-api-key"
```

## Response Format

Your webhook should return a 2xx status code to indicate success. The response body is optional.

```json
{
  "success": true,
  "message": "Email processed"
}
```

### Error Handling

Return 4xx/5xx to trigger a retry:
- `4xx` - Client error (will retry)
- `5xx` - Server error (will retry)
- `200-299` - Success (no retry)

## Health Checks

Moperator periodically checks webhook health. Ensure your endpoint responds to `HEAD` or `GET` requests at the webhook URL.

Agents are automatically disabled after 3 consecutive health check failures.

```bash
# Check agent health
curl https://your-deployment.workers.dev/health/agents

# Re-enable after fixing
curl -X POST https://your-deployment.workers.dev/agents/finance-bot/enable \
  -H "Authorization: Bearer your-api-key"
```

## Example Agent

See the `agent-example/` directory for a complete Express.js agent implementation:

```bash
cd agent-example
npm install
WEBHOOK_SECRET="your-key" ANTHROPIC_API_KEY="sk-ant-..." npm start
```

The example agent:
- Verifies HMAC signatures
- Processes incoming emails
- Analyzes content using Claude

See [agent-example/README.md](../agent-example/README.md) for details.
