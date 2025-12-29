import { loadDistributorPairingMap } from "./helpers/excelPairing.js";
import { loadProductsFromExcel } from "./helpers/excelProducts.js";

const pairingData = loadDistributorPairingMap(
  process.env.PAIRING_EXCEL_PATH || "./data/distributor_location.xlsx"
);

export const pairingMap = pairingData.locationWise;       // ✅ sales/home
export const distributorMap = pairingData.distributorWise; // ✅ slot booking

export const productsList = loadProductsFromExcel(
  process.env.PRODUCTS_EXCEL_PATH || "./data/products.xlsx"
);
