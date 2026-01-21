function normalizeRole(role) {
  return String(role || "")
    .trim()
    .toUpperCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ");
}

export const allowRoles = (...roles) => {
  const allowed = roles.map((r) => normalizeRole(r));

  return (req, res, next) => {
    const actual = normalizeRole(req.user?.role);

    if (!allowed.includes(actual)) {
      return res.status(403).json({
        message: "Access denied",
        role: actual,
        allowed
      });
    }
    next();
  };
};
