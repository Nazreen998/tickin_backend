import express from "express";
const router = express.Router();

import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";
import { getDistributorsByCodes } from "./sales.service.js";
import { pairingMap, productsList } from "../../appInit.js";

const distributors = await getDistributorsByCodes(allowedCodes);

const distributorDropdown = distributors.map((d) => ({
  code: d.distributorCode,
  name: d.distributorName,
  area: d.area,
  phoneNumber: d.phoneNumber,
}));
// ✅ Sales Officer home API
router.get(
  "/home",
  verifyToken,
  allowRoles("SALES OFFICER"),
  async (req, res) => {
    try {
      // ✅ 1) SALES OFFICER mapping based (NO LOCATION)
      const allowedCodes = req.user.allowedDistributorCodes || [];

      // ✅ If mapping exists → use it
      if (allowedCodes.length > 0) {
        // ✅ fetch full distributors from pairingMap OR DB
        // since you already have pairingMap from excel:
        // pairingMap is location wise, so not helpful.
        // so easiest now: return only codes for dropdown
        // but better: fetch from tickin_distributors table (recommended)

        return res.json({
          ok: true,
          distributorCount: allowedCodes.length,
          allowedDistributorCodes: allowedCodes,

          distributorDropdown: allowedCodes.map((c) => ({
            code: c,
            name: c, // frontend later will show name once we fetch full distributor details
          })),

          productCount: productsList.length,
          products: productsList,
        });
      }

      // ✅ 2) FALLBACK: If no mapping found
      return res.status(400).json({
        ok: false,
        message:
          "No allowed distributors mapped for this Sales Officer. Please map in tickin_salesman_distributor_map.",
      });
    } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

export default router;
