// Simple rate limiter using KV storage
// Uses sliding window approach with per-IP or per-tenant tracking

import type { Tenant, TenantSettings } from "./tenant";

interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Max requests per window
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60 * 1000,  // 1 minute
  maxRequests: 60,       // 60 requests per minute
};

const STRICT_CONFIG: RateLimitConfig = {
  windowMs: 60 * 1000,  // 1 minute
  maxRequests: 10,       // 10 requests per minute (for write operations)
};

// Per-tenant rate limit config (uses tenant settings)
function getTenantConfig(tenant: Tenant): RateLimitConfig {
  return {
    windowMs: 60 * 1000,  // 1 minute
    maxRequests: tenant.settings.rateLimitPerMinute,
  };
}

export async function checkRateLimit(
  kv: KVNamespace,
  clientId: string,
  config: RateLimitConfig = DEFAULT_CONFIG
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const key = `ratelimit:${clientId}`;
  const now = Date.now();

  // Get current entry
  const data = await kv.get(key);
  let entry: RateLimitEntry;

  if (data) {
    entry = JSON.parse(data);

    // Check if window has expired
    if (now >= entry.resetAt) {
      // Start new window
      entry = {
        count: 1,
        resetAt: now + config.windowMs,
      };
    } else {
      // Increment count in current window
      entry.count++;
    }
  } else {
    // First request, create new entry
    entry = {
      count: 1,
      resetAt: now + config.windowMs,
    };
  }

  // Calculate TTL (time until reset + small buffer)
  // Cloudflare KV requires minimum 60 second TTL
  const ttl = Math.max(60, Math.ceil((entry.resetAt - now) / 1000) + 1);

  // Save updated entry
  await kv.put(key, JSON.stringify(entry), { expirationTtl: ttl });

  const allowed = entry.count <= config.maxRequests;
  const remaining = Math.max(0, config.maxRequests - entry.count);

  return { allowed, remaining, resetAt: entry.resetAt };
}

export function getClientId(request: Request): string {
  // Try CF-Connecting-IP first (Cloudflare's real IP header)
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp;

  // Fallback to X-Forwarded-For
  const xForwardedFor = request.headers.get("X-Forwarded-For");
  if (xForwardedFor) {
    return xForwardedFor.split(",")[0].trim();
  }

  // Last resort: use a hash of various headers as identifier
  const userAgent = request.headers.get("User-Agent") || "unknown";
  return `anon-${hashString(userAgent)}`;
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

export function rateLimitResponse(resetAt: number): Response {
  const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);

  return new Response(
    JSON.stringify({
      error: "Too many requests",
      retryAfter,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": retryAfter.toString(),
      },
    }
  );
}

// Check rate limit for authenticated tenant
export async function checkTenantRateLimit(
  kv: KVNamespace,
  tenant: Tenant
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const config = getTenantConfig(tenant);
  return checkRateLimit(kv, `tenant:${tenant.id}`, config);
}

export { DEFAULT_CONFIG, STRICT_CONFIG, getTenantConfig };
export type { RateLimitConfig };
