// API Key authentication for protected endpoints

export function verifyApiKey(request: Request, apiKey: string | undefined): boolean {
  if (!apiKey) {
    // If no API key is configured, allow all requests (dev mode)
    return true;
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return false;
  }

  // Support both "Bearer <key>" and "ApiKey <key>" formats
  const parts = authHeader.split(" ");
  if (parts.length !== 2) {
    return false;
  }

  const [scheme, key] = parts;
  if (scheme !== "Bearer" && scheme !== "ApiKey") {
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  return secureCompare(key, apiKey);
}

function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

export function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "Unauthorized",
      message: "Valid API key required. Use 'Authorization: Bearer <api-key>' header.",
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer",
      },
    }
  );
}
