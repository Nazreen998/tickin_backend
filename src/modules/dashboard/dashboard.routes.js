import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";

const router = express.Router();

router.get("/master", verifyToken, allowRoles("MASTER"), (req, res) => {
  res.json({
    message: "Master dashboard access ✅",
    user: req.user,
  });
});

export default router;
