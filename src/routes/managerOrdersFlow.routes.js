import express from "express";
import { verifyToken } from "../middleware/auth.middleware.js";

const router = express.Router();

router.get("/test", verifyToken, (req, res) => {
  res.json({
    message: "✅ Manager Orders Flow backend route working",
    user: req.user,
  });
});

export default router;
