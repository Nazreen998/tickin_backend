import fs from "fs";
import path from "path";
import { loadDistributorPairingMap } from "./helpers/excelPairing.js";
import { loadProductsFromExcel } from "./helpers/excelProducts.js";

let pairingMap = {};
let productsList = [];

/* ---------------- PAIRING MAP LOAD ---------------- */
try {
  const pairingPath = process.env.PAIRING_EXCEL_PATH || "./data/location.xlsx";
  const resolvedPairingPath = path.resolve(pairingPath);

  if (!fs.existsSync(resolvedPairingPath)) {
    console.log("⚠️ pairingMap excel not found:", resolvedPairingPath);
    pairingMap = {};
  } else {
    console.log("✅ pairingMap excel found:", resolvedPairingPath);

    pairingMap = loadDistributorPairingMap(resolvedPairingPath);

    const keys = Object.keys(pairingMap || {});
    console.log("✅ pairingMap loaded locations:", keys.length);

    if (keys.length > 0) {
      console.log("📌 Sample locations:", keys.slice(0, 5));
    } else {
      console.log("⚠️ pairingMap is EMPTY. Check excel columns/sheet format.");
    }
  }
} catch (err) {
  console.error("❌ pairingMap load failed:", err.message);
  pairingMap = {};
}

/* ---------------- PRODUCTS LOAD ---------------- */
try {
  const productsPath = process.env.PRODUCTS_EXCEL_PATH || "./data/products.xlsx";
  const resolvedProductsPath = path.resolve(productsPath);

  if (!fs.existsSync(resolvedProductsPath)) {
    console.log("⚠️ products excel not found:", resolvedProductsPath);
    productsList = [];
  } else {
    console.log("✅ products excel found:", resolvedProductsPath);

    productsList = loadProductsFromExcel(resolvedProductsPath);

    console.log("✅ products loaded:", productsList.length);
    if (productsList.length > 0) {
      console.log("📌 Sample product:", productsList[0]);
    }
  }
} catch (err) {
  console.error("❌ products load failed:", err.message);
  productsList = [];
}

export { pairingMap, productsList };
