import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getTenantLabels,
  getTenantLabel,
  createTenantLabel,
  updateTenantLabel,
  deleteTenantLabel,
  validateLabelId,
  validateAssignedLabels,
  initializeTenantLabels,
} from "../labels";
import { DEFAULT_LABELS } from "../types";

// Mock KV namespace
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
    list: vi.fn(() => Promise.resolve({ keys: [], list_complete: true, cacheStatus: null })),
    getWithMetadata: vi.fn(() => Promise.resolve({ value: null, metadata: null, cacheStatus: null })),
  } as unknown as KVNamespace;
}

describe("labels", () => {
  let mockKV: KVNamespace;
  const tenantId = "test-tenant";

  beforeEach(() => {
    mockKV = createMockKV();
  });

  describe("getTenantLabels", () => {
    it("returns default labels if none defined", async () => {
      const labels = await getTenantLabels(mockKV, tenantId);

      expect(labels).toEqual(DEFAULT_LABELS);
      expect(mockKV.put).toHaveBeenCalled();
    });

    it("returns existing labels", async () => {
      const customLabels = [{ id: "custom", name: "Custom", description: "Custom label" }];
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify(customLabels),
      });

      const labels = await getTenantLabels(mockKV, tenantId);

      expect(labels).toEqual(customLabels);
    });
  });

  describe("getTenantLabel", () => {
    it("returns a label by ID", async () => {
      const customLabels = [
        { id: "finance", name: "Finance", description: "Financial emails" },
        { id: "support", name: "Support", description: "Support requests" },
      ];
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify(customLabels),
      });

      const label = await getTenantLabel(mockKV, tenantId, "finance");

      expect(label).toEqual(customLabels[0]);
    });

    it("returns null for non-existent label", async () => {
      const customLabels = [{ id: "finance", name: "Finance", description: "Financial emails" }];
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify(customLabels),
      });

      const label = await getTenantLabel(mockKV, tenantId, "nonexistent");

      expect(label).toBeNull();
    });
  });

  describe("createTenantLabel", () => {
    it("creates a new label", async () => {
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify(DEFAULT_LABELS),
      });

      const newLabel = await createTenantLabel(mockKV, tenantId, {
        id: "urgent",
        name: "Urgent",
        description: "Time-sensitive emails",
      });

      expect(newLabel.id).toBe("urgent");
      expect(newLabel.name).toBe("Urgent");
    });

    it("throws error for invalid label ID", async () => {
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify(DEFAULT_LABELS),
      });

      await expect(
        createTenantLabel(mockKV, tenantId, {
          id: "invalid id with spaces",
          name: "Invalid",
          description: "Invalid label",
        })
      ).rejects.toThrow("Label ID must contain only letters, numbers, dashes, and underscores");
    });

    it("throws error for duplicate label ID", async () => {
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify([{ id: "existing", name: "Existing", description: "Existing label" }]),
      });

      await expect(
        createTenantLabel(mockKV, tenantId, {
          id: "existing",
          name: "Duplicate",
          description: "Duplicate label",
        })
      ).rejects.toThrow("already exists");
    });

    it("throws error for empty name", async () => {
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify(DEFAULT_LABELS),
      });

      await expect(
        createTenantLabel(mockKV, tenantId, {
          id: "valid",
          name: "",
          description: "Valid description",
        })
      ).rejects.toThrow("Label name must be");
    });

    it("throws error for empty description", async () => {
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify(DEFAULT_LABELS),
      });

      await expect(
        createTenantLabel(mockKV, tenantId, {
          id: "valid",
          name: "Valid Name",
          description: "",
        })
      ).rejects.toThrow("Label description must be");
    });

    it("throws error when max labels reached", async () => {
      const manyLabels = Array.from({ length: 50 }, (_, i) => ({
        id: `label${i}`,
        name: `Label ${i}`,
        description: `Description ${i}`,
      }));
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify(manyLabels),
      });

      await expect(
        createTenantLabel(mockKV, tenantId, {
          id: "toomany",
          name: "Too Many",
          description: "Too many labels",
        })
      ).rejects.toThrow("Maximum labels");
    });
  });

  describe("updateTenantLabel", () => {
    it("updates an existing label", async () => {
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify([
          { id: "finance", name: "Finance", description: "Old description" },
        ]),
      });

      const updated = await updateTenantLabel(mockKV, tenantId, "finance", {
        name: "Finance & Bills",
        description: "New description",
      });

      expect(updated?.name).toBe("Finance & Bills");
      expect(updated?.description).toBe("New description");
    });

    it("returns null for non-existent label", async () => {
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify([]),
      });

      const updated = await updateTenantLabel(mockKV, tenantId, "nonexistent", {
        name: "Updated",
      });

      expect(updated).toBeNull();
    });

    it("throws error for invalid name", async () => {
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify([
          { id: "finance", name: "Finance", description: "Description" },
        ]),
      });

      await expect(
        updateTenantLabel(mockKV, tenantId, "finance", { name: "" })
      ).rejects.toThrow("Label name must be");
    });

    it("throws error for invalid description", async () => {
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify([
          { id: "finance", name: "Finance", description: "Description" },
        ]),
      });

      await expect(
        updateTenantLabel(mockKV, tenantId, "finance", { description: "" })
      ).rejects.toThrow("Label description must be");
    });
  });

  describe("deleteTenantLabel", () => {
    it("deletes an existing label", async () => {
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify([
          { id: "finance", name: "Finance", description: "Financial emails" },
          { id: "support", name: "Support", description: "Support requests" },
        ]),
      });

      const deleted = await deleteTenantLabel(mockKV, tenantId, "finance");

      expect(deleted).toBe(true);
    });

    it("returns false for non-existent label", async () => {
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify([]),
      });

      const deleted = await deleteTenantLabel(mockKV, tenantId, "nonexistent");

      expect(deleted).toBe(false);
    });

    it("throws error when trying to delete catch-all", async () => {
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify(DEFAULT_LABELS),
      });

      await expect(deleteTenantLabel(mockKV, tenantId, "catch-all")).rejects.toThrow(
        "Cannot delete 'catch-all' label"
      );
    });
  });

  describe("validateLabelId", () => {
    it("returns null for valid ID", () => {
      expect(validateLabelId("valid-label_123")).toBeNull();
    });

    it("returns error for empty ID", () => {
      expect(validateLabelId("")).toBe("Label ID is required");
    });

    it("returns error for ID too long", () => {
      const longId = "a".repeat(51);
      expect(validateLabelId(longId)).toContain("50 characters or less");
    });

    it("returns error for invalid characters", () => {
      expect(validateLabelId("invalid id")).toContain("letters, numbers, dashes, and underscores");
      expect(validateLabelId("invalid@id")).toContain("letters, numbers, dashes, and underscores");
    });
  });

  describe("validateAssignedLabels", () => {
    const tenantLabels = [
      { id: "finance", name: "Finance", description: "Financial" },
      { id: "support", name: "Support", description: "Support" },
      { id: "catch-all", name: "Catch All", description: "Unclassified" },
    ];

    it("returns valid labels only", () => {
      const result = validateAssignedLabels(["finance", "invalid", "support"], tenantLabels);
      expect(result).toEqual(["finance", "support"]);
    });

    it("returns catch-all if no valid labels", () => {
      const result = validateAssignedLabels(["invalid1", "invalid2"], tenantLabels);
      expect(result).toEqual(["catch-all"]);
    });

    it("returns catch-all for empty input", () => {
      const result = validateAssignedLabels([], tenantLabels);
      expect(result).toEqual(["catch-all"]);
    });
  });

  describe("initializeTenantLabels", () => {
    it("initializes labels if not existing", async () => {
      await initializeTenantLabels(mockKV, tenantId);

      expect(mockKV.put).toHaveBeenCalledWith(
        `user:${tenantId}:labels`,
        JSON.stringify(DEFAULT_LABELS)
      );
    });

    it("does not overwrite existing labels", async () => {
      const existingLabels = [{ id: "custom", name: "Custom", description: "Custom" }];
      mockKV = createMockKV({
        [`user:${tenantId}:labels`]: JSON.stringify(existingLabels),
      });

      await initializeTenantLabels(mockKV, tenantId);

      expect(mockKV.put).not.toHaveBeenCalled();
    });
  });
});
