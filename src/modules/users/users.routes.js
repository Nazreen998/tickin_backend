import express from "express";
import { assignCompany } from "./users.service.js";

const router = express.Router();

router.post("/assign-company", assignCompany);

export default router;
