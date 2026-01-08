# Project Context: Moperator (The AI Mail Gateway)

## 1. Project Identity
**Codename:** Moperator
**Vibe:** Cyberpunk / Tech-Noir / "The Mail Operator".
**Mission:** A headless, serverless event gateway that connects the chaotic "Sprawl" of global email traffic to a disciplined network of backend AI Agents. It acts as the intelligent switchboard, ingesting raw data, understanding intent, and dispatching tasks to the correct specialist.

## 2. Core Architecture
The system is built on an **Event-Driven Serverless Architecture** deployed to the Edge.

* **Infrastructure:** Cloudflare Email Workers (Serverless, V8 Isolate).
* **Language:** TypeScript.
* **Brain (Routing):** Anthropic Claude 3.5 Haiku (via REST API).
* **State (Registry):** Cloudflare KV (Key-Value Storage).
* **Protocol:** Inbound SMTP -> JSON Parsing -> Semantic Analysis -> HTTP Webhook Dispatch.

## 3. System Data Flow
1.  **Ingest:** A raw email arrives at `jackbot@moperator.ai` (assume there is a user named jack and named his email as jackbot)
2.  **Intercept:** Cloudflare Worker triggers. Spam is automatically rejected.
3.  **Parse:** The Worker uses `postal-mime` to strip HTML/CSS and extract `Subject`, `Sender`, `Text Body`, and `Attachments`.
4.  **Route (The Brain):**
    * The Worker prompts Claude Haiku with the email context + a list of active Agents from the Registry.
    * *Prompt logic:* "Here is an email. Here are the available Agents (FinanceBot, HomeBase, Security). Which one should handle this? Return strictly the AgentID."
5.  **Lookup:** Worker retrieves the `TargetWebhookURL` and `SecretKey` for that AgentID from KV.
6.  **Dispatch:** Worker fires a POST request to the Agent's webhook with a signed payload (HMAC security).
