import type { Agent, ParsedEmail, WebhookPayload } from "./types";

export async function dispatchToAgent(
  email: ParsedEmail,
  agent: Agent,
  routingReason: string,
  signingKey: string
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const timestamp = new Date().toISOString();

  const payloadWithoutSig = {
    email,
    routedTo: agent.id,
    routingReason,
    timestamp,
  };

  const signature = await signPayload(
    JSON.stringify(payloadWithoutSig),
    signingKey
  );

  const payload: WebhookPayload = {
    ...payloadWithoutSig,
    signature,
  };

  try {
    console.log(`[WEBHOOK] POST ${agent.webhookUrl}`);
    console.log(`[WEBHOOK] Signature: ${signature.slice(0, 16)}...`);
    console.log(`[WEBHOOK] Payload size: ${JSON.stringify(payload).length} bytes`);

    const response = await fetch(agent.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Moperator-Signature": signature,
        "X-Moperator-Timestamp": timestamp,
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    console.log(`[WEBHOOK] Response: ${response.status} ${response.statusText}`);
    console.log(`[WEBHOOK] Response body: ${responseText.slice(0, 200)}`);

    return {
      success: response.ok,
      statusCode: response.status,
    };
  } catch (err) {
    console.error(`[WEBHOOK] Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );

  return arrayBufferToHex(signature);
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Helper for agents to verify webhook signatures
export async function verifySignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const expected = await signPayload(payload, secret);
  return signature === expected;
}
