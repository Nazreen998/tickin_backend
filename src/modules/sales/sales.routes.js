import express from "express";
const router = express.Router();

import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";

import { productsList } from "../../appInit.js";
import { getDistributorsByCodes } from "./sales.service.js";

router.get(
  "/home",
  verifyToken,
  allowRoles("SALES OFFICER"),
  async (req, res) => {
    try {
      const allowedCodes = req.user.allowedDistributorCodes || [];

      if (!allowedCodes.length) {
        return res.status(400).json({
          ok: false,
          message:
            "No allowed distributors mapped for this Sales Officer. Please map in tickin_salesman_distributor_map.",
        });
      }

      // ✅ fetch full distributor objects from DynamoDB
      const distributors = await getDistributorsByCodes(allowedCodes);

      // ✅ Dropdown ready list
      const distributorDropdown = distributors.map((d) => ({
        code: String(d?.distributorCode || "").trim(),
        name: String(d?.distributorName || "").trim(),
        area: String(d?.area || "").trim(),
        phoneNumber: String(d?.phoneNumber || "").trim(),
      }));

      return res.json({
        ok: true,
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
