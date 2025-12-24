import { loadDistributorPairingMap } from "./helpers/excelPairing.js";

export const pairingMap = loadDistributorPairingMap(
  process.env.PAIRING_EXCEL_PATH || "./data/distributor_location.xlsx"
);
