import { updateDriverStatus, getDriverOrders } from "../services/driver.service.js";

export async function updateStatus(req, res) {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const data = await updateDriverStatus(orderId, status);

    return res.json({
      success: true,
      message: "Driver status updated",
      data,
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }
}

export async function getOrders(req, res) {
  try {
    const { driverId } = req.params;

    const data = await getDriverOrders(driverId);

    return res.json({
      success: true,
      data,
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }
}
