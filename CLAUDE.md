# Project Context: Moperator — Email for AI

## 1. Project Identity
**Codename:** Moperator
**Tagline:** Email for AI (and non-human Intelligence)
**Vibe:** Cyberpunk / Tech-Noir / "The Mail Operator"
**Mission:** The first email infrastructure built for AI agents, LLMs, and autonomous systems. Moperator connects the chaotic "Sprawl" of global email traffic to a disciplined network of AI integrations — because your agents deserve their own inbox.

## 2. Core Architecture
The system is built on an **Event-Driven Serverless Architecture** deployed to the Edge.

* **Infrastructure:** Cloudflare Email Workers (Serverless, V8 Isolate)
* **Language:** TypeScript
* **Brain (Labeling):** Anthropic Claude 3.5 Haiku (via REST API)
* **State:** Cloudflare KV (Key-Value Storage)
* **Protocol:** Inbound SMTP → Parse → Label → Store → Pull/Push

## 3. System Data Flow

```
Email Arrives → Parse → Claude Labels → Store in KV
                                            ↓
                    ┌───────────────────────┴───────────────────────┐
                    ↓                                               ↓
              AI Assistants (Pull)                         Custom Agents (Push+Pull)
         ChatGPT / Claude / Gemini                         Webhook on arrival
         Query: GET /emails?labels=finance                 + Query API anytime
```

### Detailed Flow:
1. **Ingest:** Email arrives at `yourbot@moperator.work`
2. **Intercept:** Cloudflare Worker triggers
3. **Parse:** Worker uses `postal-mime` to extract Subject, Sender, Text Body, Attachments
4. **Label (The Brain):**
   - Worker prompts Claude Haiku with email content + tenant's label definitions
   - Claude assigns one or more labels (e.g., `["finance", "urgent"]`)
   - Labels are user-defined with descriptions (e.g., "finance: invoices, receipts, bank statements")
5. **Store:** Email stored in KV with labels, instantly queryable
6. **Notify (Optional):** Agents subscribed to matching labels receive webhook (push)
7. **Query:** AI assistants and agents can query emails by label anytime (pull)

## 4. Integration Models

| Integration Type | Model | How It Works |
|-----------------|-------|--------------|
| **ChatGPT** | Pull | OpenAPI Actions → `GET /api/v1/emails?labels=finance` |
| **Claude Desktop** | Pull | MCP Protocol → `check_inbox`, `search_emails` tools |
| **Gemini** | Pull | A2A Protocol → capabilities for email access |
| **Custom Agents** | Push + Pull | Webhook on email arrival AND/OR query API |

### Custom Agent Modes:
- **Pull-only:** Agent has no `webhookUrl`, queries API on its own schedule
- **Push + Pull:** Agent has `webhookUrl`, gets notified on arrival, can also query

## 5. Key Concepts

### Labels (not Routes)
- Users define labels with descriptions (helps Claude classify)
- One email can have multiple labels
- Labels are tenant-scoped
- Default label: `catch-all` for unclassified emails

### Multi-tenant
- Each tenant has isolated: labels, agents, emails
- API key authentication: `mop_<tenant>_<secret>`
- Tenant-scoped KV keys: `user:<tenant>:email:<id>`

### Protocols
- **MCP:** Model Context Protocol for Claude Desktop
- **OpenAPI:** Actions schema for ChatGPT
- **A2A:** Agent-to-Agent protocol (Gemini Enterprise)
- **REST:** Direct API for custom integrations
