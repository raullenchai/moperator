/**
 * Label Management
 *
 * Labels are tenant-scoped email categories. Each tenant defines their own labels
 * with descriptions that guide Claude's classification. Agents subscribe to labels
 * to receive emails matching those categories.
 */

import type { Label } from "./types";
import { DEFAULT_LABELS, MAX_LABELS_PER_TENANT } from "./types";
import { tenantKey } from "./tenant";

// Validation constants
const LABEL_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const MAX_LABEL_ID_LENGTH = 50;
const MAX_LABEL_NAME_LENGTH = 100;
const MAX_LABEL_DESCRIPTION_LENGTH = 500;

// KV key for tenant's labels
function labelsKey(tenantId: string): string {
  return tenantKey(tenantId, "labels");
}

/**
 * Get all labels for a tenant. Returns default labels if none defined.
 */
export async function getTenantLabels(kv: KVNamespace, tenantId: string): Promise<Label[]> {
  const data = await kv.get(labelsKey(tenantId));
  if (!data) {
    // Initialize with default labels
    await kv.put(labelsKey(tenantId), JSON.stringify(DEFAULT_LABELS));
    return DEFAULT_LABELS;
  }
  return JSON.parse(data) as Label[];
}

/**
 * Get a single label by ID
 */
export async function getTenantLabel(kv: KVNamespace, tenantId: string, labelId: string): Promise<Label | null> {
  const labels = await getTenantLabels(kv, tenantId);
  return labels.find(l => l.id === labelId) || null;
}

/**
 * Create a new label for a tenant
 */
export async function createTenantLabel(
  kv: KVNamespace,
  tenantId: string,
  label: Omit<Label, "id"> & { id: string }
): Promise<Label> {
  // Validate label ID
  const validationError = validateLabelId(label.id);
  if (validationError) {
    throw new Error(validationError);
  }

  // Validate name and description
  if (!label.name || label.name.length > MAX_LABEL_NAME_LENGTH) {
    throw new Error(`Label name must be 1-${MAX_LABEL_NAME_LENGTH} characters`);
  }
  if (!label.description || label.description.length > MAX_LABEL_DESCRIPTION_LENGTH) {
    throw new Error(`Label description must be 1-${MAX_LABEL_DESCRIPTION_LENGTH} characters`);
  }

  const labels = await getTenantLabels(kv, tenantId);

  // Check limit
  if (labels.length >= MAX_LABELS_PER_TENANT) {
    throw new Error(`Maximum labels (${MAX_LABELS_PER_TENANT}) reached`);
  }

  // Check for duplicate
  if (labels.some(l => l.id === label.id)) {
    throw new Error(`Label '${label.id}' already exists`);
  }

  const newLabel: Label = {
    id: label.id.toLowerCase(),
    name: label.name.slice(0, MAX_LABEL_NAME_LENGTH),
    description: label.description.slice(0, MAX_LABEL_DESCRIPTION_LENGTH),
  };

  labels.push(newLabel);
  await kv.put(labelsKey(tenantId), JSON.stringify(labels));

  return newLabel;
}

/**
 * Update an existing label
 */
export async function updateTenantLabel(
  kv: KVNamespace,
  tenantId: string,
  labelId: string,
  updates: Partial<Omit<Label, "id">>
): Promise<Label | null> {
  const labels = await getTenantLabels(kv, tenantId);
  const index = labels.findIndex(l => l.id === labelId);

  if (index === -1) {
    return null;
  }

  if (updates.name !== undefined) {
    if (!updates.name || updates.name.length > MAX_LABEL_NAME_LENGTH) {
      throw new Error(`Label name must be 1-${MAX_LABEL_NAME_LENGTH} characters`);
    }
    labels[index].name = updates.name;
  }

  if (updates.description !== undefined) {
    if (!updates.description || updates.description.length > MAX_LABEL_DESCRIPTION_LENGTH) {
      throw new Error(`Label description must be 1-${MAX_LABEL_DESCRIPTION_LENGTH} characters`);
    }
    labels[index].description = updates.description;
  }

  await kv.put(labelsKey(tenantId), JSON.stringify(labels));
  return labels[index];
}

/**
 * Delete a label. Cannot delete 'catch-all' label.
 */
export async function deleteTenantLabel(kv: KVNamespace, tenantId: string, labelId: string): Promise<boolean> {
  // Prevent deleting catch-all
  if (labelId === "catch-all") {
    throw new Error("Cannot delete 'catch-all' label");
  }

  const labels = await getTenantLabels(kv, tenantId);
  const index = labels.findIndex(l => l.id === labelId);

  if (index === -1) {
    return false;
  }

  labels.splice(index, 1);
  await kv.put(labelsKey(tenantId), JSON.stringify(labels));

  return true;
}

/**
 * Validate a label ID
 */
export function validateLabelId(id: string): string | null {
  if (!id) {
    return "Label ID is required";
  }
  if (id.length > MAX_LABEL_ID_LENGTH) {
    return `Label ID must be ${MAX_LABEL_ID_LENGTH} characters or less`;
  }
  if (!LABEL_ID_REGEX.test(id)) {
    return "Label ID must contain only letters, numbers, dashes, and underscores";
  }
  return null;
}

/**
 * Validate assigned labels against tenant's defined labels.
 * Returns only valid labels, always including 'catch-all' if no valid labels found.
 */
export function validateAssignedLabels(assignedLabels: string[], tenantLabels: Label[]): string[] {
  const validIds = new Set(tenantLabels.map(l => l.id));
  const validated = assignedLabels.filter(id => validIds.has(id));

  // Always have at least one label (catch-all as fallback)
  if (validated.length === 0) {
    validated.push("catch-all");
  }

  return validated;
}

/**
 * Initialize labels for a new tenant
 */
export async function initializeTenantLabels(kv: KVNamespace, tenantId: string): Promise<void> {
  const existing = await kv.get(labelsKey(tenantId));
  if (!existing) {
    await kv.put(labelsKey(tenantId), JSON.stringify(DEFAULT_LABELS));
  }
}
