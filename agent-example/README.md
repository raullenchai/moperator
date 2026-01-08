# Moperator Agent Example

A simple agent server that receives emails from Moperator and processes them with Claude.

## Setup

```bash
cd agent-example
npm install
```

## Configuration

Set environment variables:

```bash
# Must match the WEBHOOK_SIGNING_KEY in Moperator
export WEBHOOK_SECRET="your-webhook-signing-key"

# Optional: Enable Claude analysis
export ANTHROPIC_API_KEY="sk-ant-..."
```

## Run Locally

```bash
npm start
```

Server runs on `http://localhost:3000`

## Expose with ngrok

To receive webhooks from Moperator, expose your local server:

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3000
```

Copy the ngrok URL (e.g., `https://abc123.ngrok.io`) and register it as an agent:

```bash
curl -X POST https://moperator.raullenchai.workers.dev/agents \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-agent",
    "name": "My Agent",
    "description": "Processes incoming emails with Claude",
    "webhookUrl": "https://abc123.ngrok.io/webhook"
  }'
```

## What it does

1. **Receives webhook** from Moperator with email payload
2. **Verifies signature** using HMAC-SHA256
3. **Logs email details** (from, to, subject, body preview)
4. **Analyzes with Claude** (if API key set) - summarizes and categorizes the email
5. **Responds** with success confirmation

## Example Output

```
============================================================
[AGENT] WEBHOOK RECEIVED
============================================================
[AGENT] Signature verified!
[AGENT] From: sender@example.com
[AGENT] To: inbox@moperator.work
[AGENT] Subject: Invoice #1234
[AGENT] Routed to: my-agent
[AGENT] Reason: Financial document detected
[AGENT] Claude Analysis:
1. Summary: Invoice for Q4 consulting services totaling $5,000.
2. Category: invoice
3. Suggested action: forward to accounting team
[AGENT] Processed in 1234ms
============================================================
```
