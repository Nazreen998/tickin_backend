import express from "express";
import { getDrivers } from "./users.service.js";

const router = express.Router();

router.get("/drivers", getDrivers);

export default router;
