import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";
import { getDistributorByCode } from "./distributors.service.js";

const router = express.Router();

router.get(
  "/:code",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "SALES OFFICER", "DISTRIBUTOR", "SALESMAN"),
  async (req, res) => {
    try {
      const code = req.params.code;
      const data = await getDistributorByCode(code);
      return res.json({ ok: true, distributor: data });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

export default router;
