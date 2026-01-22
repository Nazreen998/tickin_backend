import express from "express";
const router = express.Router();

import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";

import { productsList } from "../../appInit.js";
import { getDistributorsByCodes, getAllDistributors } from "./sales.service.js";

// ✅ Sales / Manager home API
router.get(
  "/home",
  verifyToken,
  allowRoles("SALES OFFICER", "MANAGER","SALES OFFICER VNR","SALES_OFFICER_VNR"),
  async (req, res) => {
    try {
      let distributors = [];

      // ✅ SALES OFFICER → only mapped distributors
      if (req.user.role === "SALES OFFICER" || req.user.role === "SALES OFFICER VNR"|| req.user.role === "SALES_OFFICER_VNR") {
        const allowedCodes = req.user.allowedDistributorCodes || [];

        if (!allowedCodes.length) {
          return res.status(400).json({
            ok: false,
            message:
              "No allowed distributors mapped for this Sales Officer. Please map in tickin_salesman_distributor_map.",
          });
        }

        distributors = await getDistributorsByCodes(allowedCodes);
      }

      // ✅ MANAGER → all distributors
      if (req.user.role === "MANAGER") {
        distributors = await getAllDistributors();
      }

      // ✅ Dropdown ready list
      const distributorDropdown = distributors.map((d) => ({
        code: String(d?.distributorCode || "").trim(),
        name: String(d?.distributorName || "").trim(),
        area: String(d?.area || "").trim(),
        phoneNumber: String(d?.phoneNumber || "").trim(),
      }));

      return res.json({
        ok: true,
        role: req.user.role,
        distributorCount: distributors.length,
        distributors,
        distributorDropdown,
        productCount: productsList.length,
        products: productsList,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

export default router;
