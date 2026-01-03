import fs from "fs";
import path from "path";
import { loadDistributorPairingMap } from "./helpers/excelPairing.js";
import { loadProductsFromExcel } from "./helpers/excelProducts.js";

let pairingMap = {};
let productsList = [];

/* ---------------- PAIRING MAP LOAD ---------------- */
function extractLatLngFromFinalUrl(url) {
  if (!url) return { lat: null, lng: null };

  const clean = String(url).trim();

  // case1: /place/9.849421,78.086520/
  const m1 = clean.match(/\/place\/(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/);
  if (m1) return { lat: Number(m1[1]), lng: Number(m1[3]) };

  // case2: /@9.849421,78.086520,17z
  const m2 = clean.match(/@(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/);
  if (m2) return { lat: Number(m2[1]), lng: Number(m2[3]) };

  // ✅ case3: !3d9.94511!4d78.17485  (THIS IS YOUR URL FORMAT)
  const m3 = clean.match(/!3d(-?\d+(\.\d+)?)!4d(-?\d+(\.\d+)?)/);
  if (m3) return { lat: Number(m3[1]), lng: Number(m3[3]) };

  // ✅ optional: q=lat,lng
  const m4 = clean.match(/[?&]q=(-?\d+(\.\d+)?),(-?\d+(\.\d+)?)/);
  if (m4) return { lat: Number(m4[1]), lng: Number(m4[3]) };

  return { lat: null, lng: null };
}


try {
  const pairingPath =
    process.env.PAIRING_EXCEL_PATH || "./data/distributor_location.xlsx";
  const resolvedPairingPath = path.resolve(pairingPath);

  if (!fs.existsSync(resolvedPairingPath)) {
    console.log("⚠️ pairingMap excel not found:", resolvedPairingPath);
    pairingMap = {};
  } else {
    console.log("✅ pairingMap excel found:", resolvedPairingPath);

    // ✅ get map
    pairingMap = loadDistributorPairingMap(resolvedPairingPath);

    // ✅ Inject lat/lng from final_url for each distributor row
    for (const locKey of Object.keys(pairingMap || {})) {
      const list = pairingMap[locKey] || [];

      pairingMap[locKey] = list.map((row) => {
        const finalUrl =
          row.final_url ||
          row.finalUrl ||
          row["final_url"] ||
          row["Final Url"] ||
          row["final url"];

        const { lat, lng } = extractLatLngFromFinalUrl(finalUrl);

        return {
          ...row,
          agencyName:
            row.agencyName || row["Agency Name"] || row["agencyName"] || null,
          distributorCode:
            row.distributorCode || row["distributorCode"] || row["Distributor Code"],
          locationBucket: String(row.Location || row.location || locKey || "UNKNOWN"),
          finalUrl: finalUrl || null,
          lat,
          lng,
        };
      });
    }

    const keys = Object.keys(pairingMap || {});
    console.log("✅ pairingMap loaded locations:", keys.length);
    if (keys.length > 0) console.log("📌 Sample locations:", keys.slice(0, 5));

    // ✅ log one sample distributor
    const firstKey = keys[0];
    if (firstKey && pairingMap[firstKey]?.length) {
      console.log("📌 Sample distributor row:", pairingMap[firstKey][0]);
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
    if (productsList.length > 0) console.log("📌 Sample product:", productsList[0]);
  }
} catch (err) {
  console.error("❌ products load failed:", err.message);
  productsList = [];
}

export { pairingMap, productsList, extractLatLngFromFinalUrl };

