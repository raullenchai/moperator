// Multi-tenant user management
// Supports 100+ users with isolated data and per-user API keys

import type { Env } from "./types";

export interface Tenant {
  id: string;
  name: string;
  email: string; // Primary email for receiving
  loginEmail?: string; // Email used for login (e.g., owen@gmail.com)
  passwordHash?: string; // Hashed password for login
  apiKey: string; // Hashed API key
  apiKeyPrefix: string; // First 8 chars for identification
  createdAt: string;
  settings: TenantSettings;
  usage: TenantUsage;
}

export interface TenantSettings {
  maxAgents: number;
  maxEmailsPerDay: number;
  rateLimitPerMinute: number;
  enabledProtocols: ("rest" | "mcp" | "a2a" | "openapi")[];
}

export interface TenantUsage {
  emailsToday: number;
  emailsTotal: number;
  lastEmailAt?: string;
  agentCount: number;
}

const DEFAULT_SETTINGS: TenantSettings = {
  maxAgents: 10,
  maxEmailsPerDay: 100,
  rateLimitPerMinute: 60,
  enabledProtocols: ["rest", "mcp", "a2a", "openapi"],
};

// ==================== API Key Management ====================

/**
 * Generate a new API key for a tenant
 * Format: mop_[userId]_[random32chars]
 */
export function generateApiKey(userId: string): string {
  const randomPart = generateRandomString(32);
  return `mop_${userId}_${randomPart}`;
}

/**
 * Hash an API key for storage (we don't store raw keys)
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Extract user ID from API key (without validating)
 */
export function extractUserIdFromKey(apiKey: string): string | null {
  if (!apiKey.startsWith("mop_")) return null;
  const parts = apiKey.split("_");
  if (parts.length !== 3) return null;
  return parts[1];
}

/**
 * Get API key prefix for display (first 8 chars after mop_)
 */
export function getApiKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, 12) + "...";
}

// ==================== Tenant CRUD ====================

/**
 * Create a new tenant
 */
export async function createTenant(
  kv: KVNamespace,
  input: { id: string; name: string; email: string }
): Promise<{ tenant: Tenant; apiKey: string }> {
  const existingTenant = await getTenant(kv, input.id);
  if (existingTenant) {
    throw new Error("Tenant already exists");
  }

  // Check if email is already registered
  const emailIndex = await kv.get(`tenant:email:${input.email.toLowerCase()}`);
  if (emailIndex) {
    throw new Error("Email already registered");
  }

  const apiKey = generateApiKey(input.id);
  const hashedKey = await hashApiKey(apiKey);

  const tenant: Tenant = {
    id: input.id,
    name: input.name,
    email: input.email.toLowerCase(),
    apiKey: hashedKey,
    apiKeyPrefix: getApiKeyPrefix(apiKey),
    createdAt: new Date().toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    usage: {
      emailsToday: 0,
      emailsTotal: 0,
      agentCount: 0,
    },
  };

  // Store tenant
  await kv.put(`tenant:${input.id}`, JSON.stringify(tenant));

  // Index by email for routing
  await kv.put(`tenant:email:${input.email.toLowerCase()}`, input.id);

  // Index by API key hash for auth
  await kv.put(`tenant:apikey:${hashedKey}`, input.id);

  console.log(`[TENANT] Created tenant ${input.id} for ${input.email}`);

  return { tenant, apiKey };
}

/**
 * Get tenant by ID
 */
export async function getTenant(
  kv: KVNamespace,
  tenantId: string
): Promise<Tenant | null> {
  const data = await kv.get(`tenant:${tenantId}`);
  if (!data) return null;
  return JSON.parse(data) as Tenant;
}

/**
 * Get tenant by email (for routing incoming emails)
 */
export async function getTenantByEmail(
  kv: KVNamespace,
  email: string
): Promise<Tenant | null> {
  // Extract the local part before @ and check if it matches a tenant
  const localPart = email.split("@")[0].toLowerCase();

  // First try direct email lookup
  const tenantId = await kv.get(`tenant:email:${email.toLowerCase()}`);
  if (tenantId) {
    return getTenant(kv, tenantId);
  }

  // Try matching by local part (e.g., jack@moperator.work -> tenant "jack")
  return getTenant(kv, localPart);
}

/**
 * Authenticate by API key and return tenant
 */
export async function authenticateByApiKey(
  kv: KVNamespace,
  apiKey: string
): Promise<Tenant | null> {
  if (!apiKey || !apiKey.startsWith("mop_")) {
    return null;
  }

  const hashedKey = await hashApiKey(apiKey);
  const tenantId = await kv.get(`tenant:apikey:${hashedKey}`);

  if (!tenantId) {
    return null;
  }

  return getTenant(kv, tenantId);
}

/**
 * Regenerate API key for a tenant
 */
export async function regenerateApiKey(
  kv: KVNamespace,
  tenantId: string
): Promise<{ apiKey: string } | null> {
  const tenant = await getTenant(kv, tenantId);
  if (!tenant) return null;

  // Delete old API key index
  await kv.delete(`tenant:apikey:${tenant.apiKey}`);

  // Generate new key
  const newApiKey = generateApiKey(tenantId);
  const hashedKey = await hashApiKey(newApiKey);

  // Update tenant
  tenant.apiKey = hashedKey;
  tenant.apiKeyPrefix = getApiKeyPrefix(newApiKey);

  await kv.put(`tenant:${tenantId}`, JSON.stringify(tenant));
  await kv.put(`tenant:apikey:${hashedKey}`, tenantId);

  console.log(`[TENANT] Regenerated API key for ${tenantId}`);

  return { apiKey: newApiKey };
}

/**
 * Update tenant settings
 */
export async function updateTenantSettings(
  kv: KVNamespace,
  tenantId: string,
  settings: Partial<TenantSettings>
): Promise<Tenant | null> {
  const tenant = await getTenant(kv, tenantId);
  if (!tenant) return null;

  tenant.settings = { ...tenant.settings, ...settings };
  await kv.put(`tenant:${tenantId}`, JSON.stringify(tenant));

  return tenant;
}

/**
 * Update tenant usage stats
 */
export async function incrementUsage(
  kv: KVNamespace,
  tenantId: string,
  field: "emailsToday" | "emailsTotal" | "agentCount",
  delta: number = 1
): Promise<void> {
  const tenant = await getTenant(kv, tenantId);
  if (!tenant) return;

  tenant.usage[field] += delta;
  if (field === "emailsToday" || field === "emailsTotal") {
    tenant.usage.lastEmailAt = new Date().toISOString();
  }

  await kv.put(`tenant:${tenantId}`, JSON.stringify(tenant));
}

/**
 * Reset daily usage (called by cron)
 */
export async function resetDailyUsage(kv: KVNamespace): Promise<number> {
  const list = await kv.list({ prefix: "tenant:" });
  let count = 0;

  for (const key of list.keys) {
    // Skip index keys like "tenant:email:xxx" or "tenant:apikey:xxx"
    if (!key.name.startsWith("tenant:") || key.name.slice(7).includes(":")) continue;

    const data = await kv.get(key.name);
    if (!data) continue;

    const tenant = JSON.parse(data) as Tenant;
    tenant.usage.emailsToday = 0;
    await kv.put(key.name, JSON.stringify(tenant));
    count++;
  }

  console.log(`[TENANT] Reset daily usage for ${count} tenants`);
  return count;
}

/**
 * List all tenants (admin only)
 */
export async function listTenants(kv: KVNamespace): Promise<Tenant[]> {
  const list = await kv.list({ prefix: "tenant:" });
  const tenants: Tenant[] = [];

  for (const key of list.keys) {
    // Skip index keys (email, apikey, login lookups)
    if (key.name.includes(":email:") || key.name.includes(":apikey:") || key.name.includes(":login:")) continue;

    const data = await kv.get(key.name);
    if (data) {
      try {
        const tenant = JSON.parse(data) as Tenant;
        // Validate it's actually a tenant object
        if (tenant.id && tenant.email) {
          tenants.push(tenant);
        }
      } catch {
        // Skip malformed entries
        console.warn(`[TENANT] Skipping malformed entry: ${key.name}`);
      }
    }
  }

  return tenants;
}

/**
 * Delete a tenant and all their data
 */
export async function deleteTenant(
  kv: KVNamespace,
  tenantId: string
): Promise<boolean> {
  const tenant = await getTenant(kv, tenantId);
  if (!tenant) return false;

  // Delete tenant record
  await kv.delete(`tenant:${tenantId}`);

  // Delete email index
  await kv.delete(`tenant:email:${tenant.email}`);

  // Delete API key index
  await kv.delete(`tenant:apikey:${tenant.apiKey}`);

  // Note: We should also delete all user's agents, emails, etc.
  // This would be done in a cleanup job for large datasets

  console.log(`[TENANT] Deleted tenant ${tenantId}`);
  return true;
}

// ==================== Tenant-Scoped Keys ====================

/**
 * Generate tenant-scoped KV key
 * Supports variadic segments: tenantKey("user1", "email", "123") -> "user:user1:email:123"
 */
export function tenantKey(tenantId: string, ...segments: string[]): string {
  return `user:${tenantId}:${segments.join(":")}`;
}

/**
 * Parse tenant-scoped KV key
 */
export function parseTenantKey(key: string): { tenantId: string; type: string; id?: string } | null {
  const match = key.match(/^user:([^:]+):([^:]+)(?::(.+))?$/);
  if (!match) return null;
  return {
    tenantId: match[1],
    type: match[2],
    id: match[3],
  };
}

// ==================== Helpers ====================

export function generateRandomString(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  return Array.from(randomValues)
    .map((v) => chars[v % chars.length])
    .join("");
}

// ==================== Auth (Signup/Login) ====================

/**
 * Hash a password for storage
 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  // Add a simple salt based on password length for basic security
  const salted = `moperator_${password}_${password.length}`;
  const data = encoder.encode(salted);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify a password against stored hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computed = await hashPassword(password);
  return computed === hash;
}

/**
 * Generate a tenant ID from email (sanitized)
 */
function generateTenantId(email: string): string {
  // Use the part before @ and sanitize
  const localPart = email.split("@")[0].toLowerCase();
  // Remove special characters, keep only alphanumeric and dash
  const sanitized = localPart.replace(/[^a-z0-9-]/g, "");
  // Add random suffix to ensure uniqueness
  const suffix = generateRandomString(6).toLowerCase();
  return `${sanitized}-${suffix}`;
}

/**
 * Signup a new user with email and password
 */
export async function signupTenant(
  kv: KVNamespace,
  input: { email: string; password: string; name?: string }
): Promise<{ tenant: Tenant; apiKey: string }> {
  const loginEmail = input.email.toLowerCase();

  // Check if login email is already registered
  const existingLogin = await kv.get(`tenant:login:${loginEmail}`);
  if (existingLogin) {
    throw new Error("Email already registered");
  }

  // Generate tenant ID from email
  const tenantId = generateTenantId(loginEmail);

  // Generate API key and hash password
  const apiKey = generateApiKey(tenantId);
  const hashedKey = await hashApiKey(apiKey);
  const passwordHash = await hashPassword(input.password);

  // Default inbox email (can be customized later)
  const inboxEmail = `${tenantId}@moperator.work`;

  const tenant: Tenant = {
    id: tenantId,
    name: input.name || loginEmail.split("@")[0],
    email: inboxEmail,
    loginEmail: loginEmail,
    passwordHash: passwordHash,
    apiKey: hashedKey,
    apiKeyPrefix: getApiKeyPrefix(apiKey),
    createdAt: new Date().toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    usage: {
      emailsToday: 0,
      emailsTotal: 0,
      agentCount: 0,
    },
  };

  // Store tenant
  await kv.put(`tenant:${tenantId}`, JSON.stringify(tenant));

  // Index by login email
  await kv.put(`tenant:login:${loginEmail}`, tenantId);

  // Index by inbox email for routing
  await kv.put(`tenant:email:${inboxEmail}`, tenantId);

  // Index by API key hash for auth
  await kv.put(`tenant:apikey:${hashedKey}`, tenantId);

  console.log(`[TENANT] Signup: ${tenantId} (${loginEmail})`);

  return { tenant, apiKey };
}

/**
 * Login with email and password, returns API key
 */
export async function loginTenant(
  kv: KVNamespace,
  email: string,
  password: string
): Promise<{ tenant: Tenant; apiKey: string } | null> {
  const loginEmail = email.toLowerCase();

  // Find tenant by login email
  const tenantId = await kv.get(`tenant:login:${loginEmail}`);
  if (!tenantId) {
    return null;
  }

  const tenant = await getTenant(kv, tenantId);
  if (!tenant || !tenant.passwordHash) {
    return null;
  }

  // Verify password
  const valid = await verifyPassword(password, tenant.passwordHash);
  if (!valid) {
    return null;
  }

  // Generate new API key on login (rotate for security)
  const newApiKey = generateApiKey(tenantId);
  const hashedKey = await hashApiKey(newApiKey);

  // Delete old API key index
  await kv.delete(`tenant:apikey:${tenant.apiKey}`);

  // Update tenant with new API key
  tenant.apiKey = hashedKey;
  tenant.apiKeyPrefix = getApiKeyPrefix(newApiKey);

  await kv.put(`tenant:${tenantId}`, JSON.stringify(tenant));
  await kv.put(`tenant:apikey:${hashedKey}`, tenantId);

  console.log(`[TENANT] Login: ${tenantId}`);

  return { tenant, apiKey: newApiKey };
}

/**
 * Get tenant by login email
 */
export async function getTenantByLoginEmail(
  kv: KVNamespace,
  email: string
): Promise<Tenant | null> {
  const loginEmail = email.toLowerCase();
  const tenantId = await kv.get(`tenant:login:${loginEmail}`);
  if (!tenantId) {
    return null;
  }
  return getTenant(kv, tenantId);
}
