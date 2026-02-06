import * as qrService from "../services/qr.service.js";
import { getQrHistory } from "../services/qr.service.js";

export async function getQrHistoryController(req, res) {
  try {
    const items = await getQrHistory();
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
}

export const scanQr = async (req, res) => {
  try {
    const qrName = req.params.qrName.toUpperCase();
    const item = await qrService.getActiveBatch(qrName);

    if (!item) {
      return res.status(404).json({
        ok: false,
        message: `No active item found for ${qrName}`
      });
    }

    res.json({ ok: true, data: item });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
};

export const takeStock = async (req, res) => {
  try {
    const { qrName, takenQty, user } = req.body;
    const result = await qrService.takeStock(qrName, takenQty, user);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
};

export const addNewBatch = async (req, res) => {
  try {
    const result = await qrService.addNewBatch(req.body);
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
};
