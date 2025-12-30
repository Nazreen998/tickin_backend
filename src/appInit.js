import { loadDistributorPairingMap } from "./helpers/excelPairing.js";
import { loadProductsFromExcel } from "./helpers/excelProducts.js";

let pairingMap = {};
let productsList = [];

try {
  pairingMap = loadDistributorPairingMap(
    process.env.PAIRING_EXCEL_PATH || "./data/location.xlsx"
  );
  console.log("✅ pairingMap loaded locations:", Object.keys(pairingMap).length);
} catch (err) {
  console.error("❌ pairingMap load failed:", err.message);
  pairingMap = {}; // ✅ fallback
}

try {
  productsList = loadProductsFromExcel(
    process.env.PRODUCTS_EXCEL_PATH || "./data/products.xlsx"
  );
  console.log("✅ products loaded:", productsList.length);
} catch (err) {
  console.error("❌ products load failed:", err.message);
  productsList = []; // ✅ fallback
}

export { pairingMap, productsList };
