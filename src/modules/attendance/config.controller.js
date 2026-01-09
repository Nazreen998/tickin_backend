import { AllowanceConfig } from "../../models/allowanceConfig.model.js";

/**
 * 🔐 MASTER ONLY middleware (inline simple check)
 */
const ensureMaster = (req, res) => {
  if (req.user.role !== "MASTER") {
    res.status(403).json({ ok: false, error: "forbidden" });
    return false;
  }
  return true;
};

/**
 * GET /attendance/config/allowance
 * MASTER only
 */
export const getAllowanceConfig = async (req, res) => {
  if (!ensureMaster(req, res)) return;

  try {
    const config = await AllowanceConfig.get();
    res.json({ ok: true, data: config });
  } catch (e) {
    res.status(500).json({ ok: false, error: "config_fetch_failed" });
  }
};

/**
 * PUT /attendance/config/allowance
 * MASTER only
 */
export const updateAllowanceConfig = async (req, res) => {
  if (!ensureMaster(req, res)) return;

  const {
    managerLoadmanBata,
    driverMorningBata,
    driverNightAllowance,
    managerLoadmanCheckin,
    driverCheckinNormal,
    driverCheckinAfterNightDuty,
  } = req.body;

  // 🔒 Basic validation
  if (
    managerLoadmanBata == null ||
    driverMorningBata == null ||
    driverNightAllowance == null ||
    !managerLoadmanCheckin ||
    !driverCheckinNormal ||
    !driverCheckinAfterNightDuty
  ) {
    return res.json({ ok: false, error: "invalid_payload" });
  }

  try {
    await AllowanceConfig.update({
      managerLoadmanBata,
      driverMorningBata,
      driverNightAllowance,
      managerLoadmanCheckin,
      driverCheckinNormal,
      driverCheckinAfterNightDuty,
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "config_update_failed" });
  }
};
