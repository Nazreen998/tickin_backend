export const transitions = {
  // Manager -> Driver
  DRIVER_ASSIGNED: ["DRIVE_STARTED", "DRIVER_STARTED"],

  // Start trip
  DRIVE_STARTED: ["DRIVER_REACHED_DISTRIBUTOR", "REACHED_D1", "REACHED_D2"],
  DRIVER_STARTED: ["DRIVER_REACHED_DISTRIBUTOR", "REACHED_D1", "REACHED_D2"],

  // Generic reach (old) -> unload
  DRIVER_REACHED_DISTRIBUTOR: ["UNLOAD_START", "UNLOADING_START_D1", "UNLOADING_START_D2"],

  // D1/D2 reach -> unload start
  REACHED_D1: ["UNLOAD_START", "UNLOADING_START_D1"],
  REACHED_D2: ["UNLOAD_START", "UNLOADING_START_D2"],

  // Unload start -> unload end
  UNLOAD_START: ["UNLOAD_END", "UNLOADING_END_D1", "UNLOADING_END_D2"],
  UNLOADING_START_D1: ["UNLOAD_END", "UNLOADING_END_D1"],
  UNLOADING_START_D2: ["UNLOAD_END", "UNLOADING_END_D2"],

  // Unload end -> next reach OR warehouse
  UNLOAD_END: ["DRIVER_REACHED_DISTRIBUTOR", "REACHED_D1", "REACHED_D2", "WAREHOUSE_REACHED"],
  UNLOADING_END_D1: ["DRIVER_REACHED_DISTRIBUTOR", "REACHED_D2", "WAREHOUSE_REACHED"],
  UNLOADING_END_D2: ["WAREHOUSE_REACHED"],

  // End trip
  WAREHOUSE_REACHED: ["DELIVERY_COMPLETED"],
  DELIVERY_COMPLETED: [],
};

export function validateTransition(current, next) {
  const c = String(current || "").toUpperCase();
  const n = String(next || "").toUpperCase();

  const allowed = transitions[c] || [];
  if (!allowed.includes(n)) {
    throw new Error(`Invalid status transition: ${c} -> ${n}`);
  }
}
