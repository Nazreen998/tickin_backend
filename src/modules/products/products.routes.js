import express from "express";
import { verifyToken } from "../../middleware/auth.middleware.js";
import { allowRoles } from "../../middleware/role.middleware.js";
import { listProducts } from "./products.service.js";

const router = express.Router();

// ✅ Everyone except DRIVER can view products
router.get(
  "/",
  verifyToken,
  allowRoles("MASTER", "MANAGER", "SALES OFFICER", "DISTRIBUTOR"),
  listProducts
);

export default router;
