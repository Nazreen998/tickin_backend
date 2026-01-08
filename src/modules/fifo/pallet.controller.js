import { Pallet } from "./pallet.model.js";

export const scanPallet = async (req, res) => {
  const { palletId } = req.params;

  const pallet = await Pallet.getById(palletId);
  if (!pallet) {
    return res.json({ exists: false });
  }

  res.json({
    exists: true,
    data: {
      palletId,
      productCode,
      productName,
      mfgDate,
      expDate,
      totalCases: pallet.totalCases,
      remainingCases: pallet.remainingCases,
      status: pallet.remainingCases > 0 ? "ACTIVE" : "EMPTY",
      createdAt: pallet.createdAt
    }
  });
};

export const createPallet = async (req, res) => {
  try {
    await Pallet.create(req.body);
    res.json({ success: true, message: "Pallet created" });
  } catch {
    res.json({ success: false, message: "Pallet already exists" });
  }
};

export const consumeCases = async (req, res) => {
  const { palletId, consumeCases } = req.body;
  
  // ✅ ADD HERE (TOP)
  if (!palletId || typeof consumeCases !== "number" || consumeCases <= 0) {
    return res.json({
      success: false,
      message: "invalid_input"
    });
  }

  try {
    const updated = await Pallet.consume(palletId, consumeCases);

    if (updated.remainingCases === 0) {
      await Pallet.delete(palletId);
      return res.json({ success: true, remainingCases: 0, deleted: true });
    }

    res.json({ success: true, remainingCases: updated.remainingCases, deleted: false });
  } catch {
    res.json({ success: false, message: "Consume exceeds remaining" });
  }
};

export const fifoDashboard = async (req, res) => {
  const { productCode } = req.query;

  if (!productCode) {
    return res.json({ success: false, error: "productCode_required" });
  }

  const pallets = await Pallet.fifoByProduct(productCode);

  res.json({
    productCode,
    pallets: pallets.map(p => ({
      palletId: p.palletId,
      mfgDate: p.mfgDate,
      remainingCases: p.remainingCases
    }))
  });
};
