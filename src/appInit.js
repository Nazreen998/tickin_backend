import { loadDistributorPairingMap } from "./helpers/excelPairing.js";
import { loadProductsFromExcel } from "./helpers/excelProducts.js";

const pairingData = loadDistributorPairingMap(
  process.env.PAIRING_EXCEL_PATH || "./data/distributor_location.xlsx"
);

// ✅ sales/home uses this
export const pairingMap = pairingData.locationWise;

// ✅ slot.service.js uses this
export const distributorMap = pairingData.distributorWise;

export const productsList = loadProductsFromExcel(
  process.env.PRODUCTS_EXCEL_PATH || "./data/products.xlsx"
);
