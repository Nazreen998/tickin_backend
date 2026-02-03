// src/utils/orderResolver.js

/**
 * flowKey / mergeKey / orderId → orderIds[]
 * Supports:
 *  - ORD_xxx
 *  - ORD_FULL_xxx
 *  - comma separated
 *  - array
 */

export async function resolveOrderIdsFromFlowKey(key) {
  if (!key) return [];

  // already array
  if (Array.isArray(key)) return key;

  // comma separated
  if (typeof key === "string" && key.includes(",")) {
    return key.split(",").map((k) => k.trim());
  }

  // single
  return [key];
}

export function normalizeOrderId(id) {
  if (!id) return null;
  return String(id).trim();
}
