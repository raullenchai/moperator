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
* **Frontend:** Single-page app with Alpine.js + Tailwind CSS (Cloudflare Pages)

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
- Default label: `catchall` for unclassified emails
- **ID format:** lowercase letters only (`[a-z]+`), e.g., `finance`, `security`, `personalemail`

### Multi-tenant Authentication
- **Signup/Login:** Email + password authentication
- Password hashed with SHA-256 + salt
- API key format: `mop_<tenantid>_<secret>`
- API key rotates on each login for security
- Tenant-scoped KV keys: `user:<tenant>:email:<id>`

### ID Conventions (Security)
All IDs must be **lowercase letters only** (`[a-z]+`):
- Label IDs: `finance`, `security`, `urgent`
- Agent IDs: `financebot`, `slackalerts`
- Tenant IDs: auto-generated from email, e.g., `owen-abc123`

This prevents injection attacks and ensures clean URLs/keys.

### Protocols
- **MCP:** Model Context Protocol for Claude Desktop
- **OpenAPI:** Actions schema for ChatGPT
- **A2A:** Agent-to-Agent protocol (Gemini Enterprise)
- **REST:** Direct API for custom integrations

## 6. Project Structure

```
moperator/
├── src/
│   ├── index.ts          # Worker entry point, API routes
│   ├── tenant.ts         # Multi-tenant auth, signup/login
│   ├── labeler.ts        # Claude labeling logic
│   ├── dispatcher.ts     # Webhook dispatch
│   ├── protocols/        # MCP, OpenAPI, A2A implementations
│   ├── types.ts          # TypeScript interfaces
│   └── __tests__/        # Test files
├── app/                  # Frontend dashboard (Cloudflare Pages)
│   ├── index.html        # Single-page app (Alpine.js + Tailwind)
│   └── logo.svg          # App logo
├── wrangler.toml         # Cloudflare config
└── CLAUDE.md             # This file
```

## 7. API Endpoints

### Auth (Public)
- `POST /auth/signup` - Create account with email/password
- `POST /auth/login` - Login, returns API key

### Labels (Authenticated)
- `GET /api/v1/labels` - List tenant's labels
- `POST /api/v1/labels` - Create label
- `PUT /api/v1/labels/:id` - Update label
- `DELETE /api/v1/labels/:id` - Delete label

### Agents (Authenticated)
- `GET /api/v1/agents` - List tenant's agents
- `POST /api/v1/agents` - Register agent with webhook + labels
- `PUT /api/v1/agents/:id` - Update agent
- `DELETE /api/v1/agents/:id` - Delete agent

### Emails (Authenticated)
- `GET /api/v1/emails` - List emails
  - `?labels=finance,urgent` - Filter by labels
  - `?status=unread` - Filter by status (unread/read)
  - Returns `unreadCount` in response
- `GET /api/v1/emails/:id` - Get single email
  - `?markRead=true` - Auto-mark as read when fetching
- `GET /api/v1/emails/search` - Search by from/subject/labels
- `PATCH /api/v1/emails/:id` - Update email status
  - Body: `{ "status": "read" }` or `{ "status": "unread" }`

### Integrations (Authenticated)
- `GET /api/v1/integrations` - List custom integrations
- `POST /api/v1/integrations` - Create integration with label scope
- `PUT /api/v1/integrations/:id` - Update integration
- `DELETE /api/v1/integrations/:id` - Delete integration

### Protocols
- `GET /mcp` - MCP endpoint for Claude Desktop
- `GET /openapi.json` - OpenAPI schema for ChatGPT
- `GET /.well-known/agent.json` - A2A agent card for Gemini

## 8. Deployment

```bash
# Backend (Cloudflare Workers)
npm run deploy

# Frontend (Cloudflare Pages)
npx wrangler pages deploy app --project-name moperator-app
```

## 9. Environment Variables (Secrets)

- `ANTHROPIC_API_KEY` - Claude API key for labeling
- `WEBHOOK_SIGNING_KEY` - HMAC key for webhook signatures
- `ADMIN_API_KEY` - Admin operations (optional)

## 10. Email Status

Emails have a read/unread status:
- **New emails** arrive as `status: 'unread'`
- **UI indicators:** Blue dot + bold text for unread emails
- **Auto-mark:** Use `?markRead=true` when fetching to auto-mark as read
- **Manual update:** `PATCH /api/v1/emails/:id` with `{ "status": "read" }` or `{ "status": "unread" }`
- **Backwards compatible:** Older emails without status default to `'read'`

### AI Agent Behavior
- Agents can fetch emails without marking them read (default)
- Agents can opt-in to mark as read: `GET /api/v1/emails/:id?markRead=true`
- Frontend dashboard always uses `?markRead=true` for user opens

## 11. Label-Based Integrations

All integrations are label-scoped:
- **Quick Start:** Pre-configured for Claude Desktop, ChatGPT, REST API with `catch-all` access
- **Custom Integrations:** Create with specific labels → scoped API key
- Each custom integration gets its own API key that only sees subscribed labels

### Integration Types
| Type | Protocol | Use Case |
|------|----------|----------|
| MCP | Claude Desktop | `check_inbox`, `read_email` tools |
| OpenAI Action | ChatGPT | GPT Actions via OpenAPI schema |
| Webhook | Custom agents | Push notifications on email arrival |
| API | Direct access | REST API for scripts/apps |
