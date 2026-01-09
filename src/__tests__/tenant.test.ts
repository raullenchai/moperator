import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateApiKey,
  hashApiKey,
  extractUserIdFromKey,
  getApiKeyPrefix,
  createTenant,
  getTenant,
  getTenantByEmail,
  authenticateByApiKey,
  regenerateApiKey,
  updateTenantSettings,
  incrementUsage,
  resetDailyUsage,
  listTenants,
  deleteTenant,
  tenantKey,
  parseTenantKey,
} from "../tenant";

// Mock KV namespace with internal store
function createMockKV(data: Record<string, string> = {}): KVNamespace {
  const store = { ...data };
  return {
    get: vi.fn((key: string) => Promise.resolve(store[key] || null)),
    put: vi.fn((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      delete store[key];
      return Promise.resolve();
    }),
    list: vi.fn(() => {
      const keys = Object.keys(store).map(name => ({ name }));
      return Promise.resolve({ keys, list_complete: true, cacheStatus: null });
    }),
    getWithMetadata: vi.fn(() => Promise.resolve({ value: null, metadata: null, cacheStatus: null })),
  } as unknown as KVNamespace;
}

describe("tenant", () => {
  let mockKV: KVNamespace;

  beforeEach(() => {
    mockKV = createMockKV();
  });

  describe("generateApiKey", () => {
    it("generates key with correct format", () => {
      const key = generateApiKey("testuser");
      expect(key).toMatch(/^mop_testuser_[a-zA-Z0-9]{32}$/);
    });

    it("generates unique keys", () => {
      const key1 = generateApiKey("user");
      const key2 = generateApiKey("user");
      expect(key1).not.toBe(key2);
    });
  });

  describe("hashApiKey", () => {
    it("produces consistent hash", async () => {
      const hash1 = await hashApiKey("test-key");
      const hash2 = await hashApiKey("test-key");
      expect(hash1).toBe(hash2);
    });

    it("produces different hash for different keys", async () => {
      const hash1 = await hashApiKey("key1");
      const hash2 = await hashApiKey("key2");
      expect(hash1).not.toBe(hash2);
    });

    it("produces 64-char hex string", async () => {
      const hash = await hashApiKey("test");
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("extractUserIdFromKey", () => {
    it("extracts user ID from valid key", () => {
      const userId = extractUserIdFromKey("mop_testuser_abc123def456");
      expect(userId).toBe("testuser");
    });

    it("returns null for invalid format", () => {
      expect(extractUserIdFromKey("invalid")).toBeNull();
      expect(extractUserIdFromKey("mop_notenough")).toBeNull();
      expect(extractUserIdFromKey("notmop_user_secret")).toBeNull();
    });
  });

  describe("getApiKeyPrefix", () => {
    it("returns first 12 chars with ellipsis", () => {
      const prefix = getApiKeyPrefix("mop_testuser_abcdefghijklmnop");
      expect(prefix).toBe("mop_testuser...");
    });
  });

  describe("createTenant", () => {
    it("creates a new tenant", async () => {
      const result = await createTenant(mockKV, {
        id: "newuser",
        name: "New User",
        email: "new@example.com",
      });

      expect(result.tenant.id).toBe("newuser");
      expect(result.tenant.name).toBe("New User");
      expect(result.tenant.email).toBe("new@example.com");
      expect(result.apiKey).toMatch(/^mop_newuser_/);
    });

    it("throws error for duplicate tenant ID", async () => {
      const existingTenant = {
        id: "existing",
        name: "Existing",
        email: "existing@example.com",
        apiKey: "hashed",
        apiKeyPrefix: "mop_existin...",
        createdAt: new Date().toISOString(),
        settings: {},
        usage: {},
      };
      mockKV = createMockKV({
        "tenant:existing": JSON.stringify(existingTenant),
      });

      await expect(
        createTenant(mockKV, {
          id: "existing",
          name: "Duplicate",
          email: "dup@example.com",
        })
      ).rejects.toThrow("Tenant already exists");
    });

    it("throws error for duplicate email", async () => {
      mockKV = createMockKV({
        "tenant:email:used@example.com": "someuser",
      });

      await expect(
        createTenant(mockKV, {
          id: "newuser",
          name: "New User",
          email: "used@example.com",
        })
      ).rejects.toThrow("Email already registered");
    });
  });

  describe("getTenant", () => {
    it("returns tenant by ID", async () => {
      const tenant = {
        id: "testuser",
        name: "Test User",
        email: "test@example.com",
        apiKey: "hashed",
        apiKeyPrefix: "mop_testuse...",
        createdAt: new Date().toISOString(),
        settings: { maxAgents: 10 },
        usage: { emailsToday: 5 },
      };
      mockKV = createMockKV({
        "tenant:testuser": JSON.stringify(tenant),
      });

      const result = await getTenant(mockKV, "testuser");

      expect(result?.id).toBe("testuser");
      expect(result?.name).toBe("Test User");
    });

    it("returns null for non-existent tenant", async () => {
      const result = await getTenant(mockKV, "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("getTenantByEmail", () => {
    it("finds tenant by email lookup", async () => {
      const tenant = {
        id: "emailuser",
        name: "Email User",
        email: "email@example.com",
        apiKey: "hashed",
        apiKeyPrefix: "mop_emailus...",
        createdAt: new Date().toISOString(),
        settings: {},
        usage: {},
      };
      mockKV = createMockKV({
        "tenant:email:email@example.com": "emailuser",
        "tenant:emailuser": JSON.stringify(tenant),
      });

      const result = await getTenantByEmail(mockKV, "email@example.com");

      expect(result?.id).toBe("emailuser");
    });

    it("finds tenant by local part", async () => {
      const tenant = {
        id: "jack",
        name: "Jack",
        email: "jack@moperator.work",
        apiKey: "hashed",
        apiKeyPrefix: "mop_jack...",
        createdAt: new Date().toISOString(),
        settings: {},
        usage: {},
      };
      mockKV = createMockKV({
        "tenant:jack": JSON.stringify(tenant),
      });

      const result = await getTenantByEmail(mockKV, "jack@moperator.work");

      expect(result?.id).toBe("jack");
    });

    it("returns null for unknown email", async () => {
      const result = await getTenantByEmail(mockKV, "unknown@example.com");
      expect(result).toBeNull();
    });
  });

  describe("authenticateByApiKey", () => {
    it("authenticates with valid key", async () => {
      const apiKey = "mop_testuser_abcdefghijklmnopqrstuvwxyz123456";
      const hashedKey = await hashApiKey(apiKey);
      const tenant = {
        id: "testuser",
        name: "Test",
        email: "test@example.com",
        apiKey: hashedKey,
        apiKeyPrefix: "mop_testuse...",
        createdAt: new Date().toISOString(),
        settings: {},
        usage: {},
      };
      mockKV = createMockKV({
        [`tenant:apikey:${hashedKey}`]: "testuser",
        "tenant:testuser": JSON.stringify(tenant),
      });

      const result = await authenticateByApiKey(mockKV, apiKey);

      expect(result?.id).toBe("testuser");
    });

    it("returns null for invalid key format", async () => {
      const result = await authenticateByApiKey(mockKV, "invalid");
      expect(result).toBeNull();
    });

    it("returns null for empty key", async () => {
      const result = await authenticateByApiKey(mockKV, "");
      expect(result).toBeNull();
    });

    it("returns null for unknown key", async () => {
      const result = await authenticateByApiKey(mockKV, "mop_unknown_abcdefghijklmnopqrstuvwxyz123456");
      expect(result).toBeNull();
    });
  });

  describe("regenerateApiKey", () => {
    it("regenerates key for existing tenant", async () => {
      const oldHash = await hashApiKey("mop_testuser_oldkey12345678901234567890");
      const tenant = {
        id: "testuser",
        name: "Test",
        email: "test@example.com",
        apiKey: oldHash,
        apiKeyPrefix: "mop_testuse...",
        createdAt: new Date().toISOString(),
        settings: {},
        usage: {},
      };
      mockKV = createMockKV({
        "tenant:testuser": JSON.stringify(tenant),
        [`tenant:apikey:${oldHash}`]: "testuser",
      });

      const result = await regenerateApiKey(mockKV, "testuser");

      expect(result?.apiKey).toMatch(/^mop_testuser_/);
      expect(mockKV.delete).toHaveBeenCalledWith(`tenant:apikey:${oldHash}`);
    });

    it("returns null for non-existent tenant", async () => {
      const result = await regenerateApiKey(mockKV, "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("updateTenantSettings", () => {
    it("updates settings", async () => {
      const tenant = {
        id: "testuser",
        name: "Test",
        email: "test@example.com",
        apiKey: "hashed",
        apiKeyPrefix: "mop_testuse...",
        createdAt: new Date().toISOString(),
        settings: { maxAgents: 10, maxEmailsPerDay: 100 },
        usage: {},
      };
      mockKV = createMockKV({
        "tenant:testuser": JSON.stringify(tenant),
      });

      const result = await updateTenantSettings(mockKV, "testuser", {
        maxAgents: 20,
      });

      expect(result?.settings.maxAgents).toBe(20);
      expect(result?.settings.maxEmailsPerDay).toBe(100);
    });

    it("returns null for non-existent tenant", async () => {
      const result = await updateTenantSettings(mockKV, "nonexistent", {});
      expect(result).toBeNull();
    });
  });

  describe("incrementUsage", () => {
    it("increments usage field", async () => {
      const tenant = {
        id: "testuser",
        name: "Test",
        email: "test@example.com",
        apiKey: "hashed",
        apiKeyPrefix: "mop_testuse...",
        createdAt: new Date().toISOString(),
        settings: {},
        usage: { emailsToday: 5, emailsTotal: 100, agentCount: 2 },
      };
      mockKV = createMockKV({
        "tenant:testuser": JSON.stringify(tenant),
      });

      await incrementUsage(mockKV, "testuser", "emailsToday", 1);

      expect(mockKV.put).toHaveBeenCalled();
    });

    it("does nothing for non-existent tenant", async () => {
      await incrementUsage(mockKV, "nonexistent", "emailsToday");
      expect(mockKV.put).not.toHaveBeenCalled();
    });
  });

  describe("resetDailyUsage", () => {
    it("resets emailsToday for all tenants", async () => {
      const tenant1 = { id: "user1", usage: { emailsToday: 50, emailsTotal: 100, agentCount: 1 } };
      const tenant2 = { id: "user2", usage: { emailsToday: 30, emailsTotal: 50, agentCount: 2 } };

      // Create mock with custom list that returns tenant keys
      const store: Record<string, string> = {
        "tenant:user1": JSON.stringify(tenant1),
        "tenant:user2": JSON.stringify(tenant2),
      };
      mockKV = {
        get: vi.fn((key: string) => Promise.resolve(store[key] || null)),
        put: vi.fn((key: string, value: string) => {
          store[key] = value;
          return Promise.resolve();
        }),
        delete: vi.fn(),
        list: vi.fn(({ prefix }: { prefix: string }) => {
          const keys = Object.keys(store)
            .filter(k => k.startsWith(prefix))
            .map(name => ({ name }));
          return Promise.resolve({ keys, list_complete: true, cacheStatus: null });
        }),
        getWithMetadata: vi.fn(() => Promise.resolve({ value: null, metadata: null, cacheStatus: null })),
      } as unknown as KVNamespace;

      const count = await resetDailyUsage(mockKV);

      expect(count).toBe(2);
    });
  });

  describe("listTenants", () => {
    it("lists all tenants", async () => {
      const tenant1 = { id: "user1", name: "User 1" };
      const tenant2 = { id: "user2", name: "User 2" };
      mockKV = createMockKV({
        "tenant:user1": JSON.stringify(tenant1),
        "tenant:user2": JSON.stringify(tenant2),
        "tenant:email:user1@example.com": "user1",
        "tenant:apikey:hash123": "user1",
      });

      const tenants = await listTenants(mockKV);

      expect(tenants).toHaveLength(2);
      expect(tenants.map(t => t.id).sort()).toEqual(["user1", "user2"]);
    });
  });

  describe("deleteTenant", () => {
    it("deletes tenant and indexes", async () => {
      const tenant = {
        id: "deleteuser",
        name: "Delete",
        email: "delete@example.com",
        apiKey: "hashedkey",
        apiKeyPrefix: "mop_delete...",
        createdAt: new Date().toISOString(),
        settings: {},
        usage: {},
      };
      mockKV = createMockKV({
        "tenant:deleteuser": JSON.stringify(tenant),
      });

      const result = await deleteTenant(mockKV, "deleteuser");

      expect(result).toBe(true);
      expect(mockKV.delete).toHaveBeenCalledWith("tenant:deleteuser");
      expect(mockKV.delete).toHaveBeenCalledWith("tenant:email:delete@example.com");
      expect(mockKV.delete).toHaveBeenCalledWith("tenant:apikey:hashedkey");
    });

    it("returns false for non-existent tenant", async () => {
      const result = await deleteTenant(mockKV, "nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("tenantKey", () => {
    it("generates tenant-scoped key", () => {
      expect(tenantKey("user1", "email", "123")).toBe("user:user1:email:123");
      expect(tenantKey("user1", "agent")).toBe("user:user1:agent");
    });
  });

  describe("parseTenantKey", () => {
    it("parses tenant key", () => {
      const result = parseTenantKey("user:user1:email:123");
      expect(result).toEqual({ tenantId: "user1", type: "email", id: "123" });
    });

    it("parses key without ID", () => {
      const result = parseTenantKey("user:user1:labels");
      expect(result).toEqual({ tenantId: "user1", type: "labels", id: undefined });
    });

    it("returns null for invalid key", () => {
      expect(parseTenantKey("invalid")).toBeNull();
      expect(parseTenantKey("wrong:format")).toBeNull();
    });
  });
});
