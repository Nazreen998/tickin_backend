function norm(s) {
  return String(s || "").trim().toUpperCase();
}

// stage-status -> canonical groups (for transition allow)
function groupStatus(s) {
  const x = norm(s);

  if (x === "DRIVE_STARTED") return "DRIVER_STARTED"; // alias
  if (x.startsWith("REACHED_D")) return "REACHED";
  if (x.startsWith("UNLOADING_START_D")) return "UNLOADING_START";
  if (x.startsWith("UNLOADING_END_D")) return "UNLOADING_END";

  return x;
}

export const transitions = {
  DRIVER_ASSIGNED: ["DRIVER_STARTED"],

  DRIVER_STARTED: ["REACHED"],

  REACHED: ["UNLOADING_START"],

  UNLOADING_START: ["UNLOADING_END"],

  UNLOADING_END: ["REACHED", "WAREHOUSE_REACHED"],

  WAREHOUSE_REACHED: ["DELIVERY_COMPLETED"],
  DELIVERY_COMPLETED: [],
};

export function validateTransition(current, next) {
  const c = groupStatus(current);
  const n = groupStatus(next);

  const allowed = transitions[c] || [];
  if (!allowed.includes(n)) {
    throw new Error(`Invalid status transition: ${c} -> ${n}`);
  }
}
