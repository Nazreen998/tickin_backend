export const allowRoles = (...roles) => {
  const allowed = roles.map(r => String(r || "").trim().toUpperCase());

  return (req, res, next) => {
    const actual = String(req.user?.role || "").trim().toUpperCase();

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
