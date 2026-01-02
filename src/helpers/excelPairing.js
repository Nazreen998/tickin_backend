import fs from "fs";
import path from "path";
import xlsx from "xlsx";

function pick(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== "") {
      return String(row[k]).trim();
    }
  }
  return "";
}

function extractCoords(url) {
  if (!url || typeof url !== "string") return null;

  // ✅ @lat,lng format
  const m1 = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m1) return { lat: Number(m1[1]), lng: Number(m1[2]) };

  // ✅ place/lat,lng format
  const m2 = url.match(/place\/(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m2) return { lat: Number(m2[1]), lng: Number(m2[2]) };

  // ✅ NEW ✅ !3dLAT!4dLNG format (your link format)
  const m3 = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m3) return { lat: Number(m3[1]), lng: Number(m3[2]) };

  return null;
}

export function loadDistributorPairingMap(filePath) {
  const finalPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(finalPath)) throw new Error(`Pairing excel not found: ${finalPath}`);

  const workbook = xlsx.readFile(finalPath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet);

  console.log("📌 pairingMap sheet:", sheetName);
  console.log("📌 pairingMap rows:", rows.length);
  if (rows.length > 0) console.log("📌 pairingMap first row keys:", Object.keys(rows[0]));

  const pairingMap = {};

  for (const row of rows) {
    const distributorCode = pick(row, [
      "Distributor Code",
      "Distributor_Code",
      "DISTRIBUTOR_CODE",
      "distributorCode",
      "code",
      "CODE",
    ]);

    const distributorName = pick(row, [
      "DISTRIBUTOR NAME",
      "DISTRIBUTOR_NAME",
      "Distributor Name",
      "Distributor_Name",
    ]);

    const finalUrl = pick(row, ["final_url", "FINAL_URL"]);
    const coords = extractCoords(finalUrl);

    // ✅ Use GEO bucket if coords exist
    let locationBucket = "UNKNOWN";
    if (coords?.lat && coords?.lng) {
      locationBucket = `GEO#${coords.lat.toFixed(2)}_${coords.lng.toFixed(2)}`;
    }

    if (!distributorCode) continue;

    if (!pairingMap[locationBucket]) pairingMap[locationBucket] = [];

    pairingMap[locationBucket].push({
      distributorCode: distributorCode.trim(),
      distributorName: distributorName || null,
      code: distributorCode.trim(),
      finalUrl: finalUrl || null,
      lat: coords?.lat || null,
      lng: coords?.lng || null,
      locationBucket, // ✅ important for merge
    });
  }

  return pairingMap;
}
