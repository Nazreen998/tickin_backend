import express from "express";
const router = express.Router();

import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";

import { pairingMap, productsList } from "../../appInit.js";

// ✅ Sales Officer home API
router.get(
  "/home",
  verifyToken,
  allowRoles("SALES OFFICER"),
  async (req, res) => {
    try {
      // ✅ IMPORTANT: token must contain location (1/2/3/4/5)
      const location = String(req.user.location || req.user.Location || "").trim();
      
      if (!location) {
        return res.status(400).json({
          ok: false,
          message: "Salesman location missing in token. Add location in login JWT.",
        });
      }

      const distributors = (pairingMap?.[location] || []);

      return res.json({
        ok: true,
        salesmanLocation: location,
        distributorCount: distributors.length,
        distributors,
        productCount: productsList.length,
        products: productsList,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

export default router;
