export const transitions = {
  DRIVER_ASSIGNED: ["DRIVER_STARTED"],
  DRIVER_STARTED: ["DRIVER_REACHED_DISTRIBUTOR"],
  DRIVER_REACHED_DISTRIBUTOR: ["UNLOAD_START"],
  UNLOAD_START: ["UNLOAD_END"],
  UNLOAD_END: ["DRIVER_REACHED_DISTRIBUTOR", "WAREHOUSE_REACHED"],
  WAREHOUSE_REACHED: [],
};

export function validateTransition(current, next) {
  const allowed = transitions[current] || [];
  if (!allowed.includes(next)) {
    throw new Error(`Invalid status transition: ${current} -> ${next}`);
  }
}
