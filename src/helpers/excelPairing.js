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

export function loadDistributorPairingMap(filePath) {
  const finalPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(finalPath)) {
    throw new Error(`Pairing excel not found: ${finalPath}`);
  }

  const workbook = xlsx.readFile(finalPath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet);

  console.log("📌 pairingMap sheet:", sheetName);
  console.log("📌 pairingMap rows:", rows.length);

  if (rows.length > 0) {
    console.log("📌 pairingMap first row keys:", Object.keys(rows[0]));
  }

  const pairingMap = {};

  for (const row of rows) {
    const location = pick(row, ["location", "LOCATION", "Location", "LOC"]);
    const distributorCode = pick(row, [
      "distributorCode",
      "DISTRIBUTOR_CODE",
      "DistributorCode",
      "code",
      "CODE",
      "distributor",
      "DISTRIBUTOR",
    ]);

    const distributorId = pick(row, ["distributorId", "DISTRIBUTOR_ID", "id", "ID"]);
    const distributorName = pick(row, ["distributorName", "DISTRIBUTOR_NAME", "name", "NAME"]);

    if (!location || !distributorCode) continue;

    if (!pairingMap[location]) pairingMap[location] = [];

    pairingMap[location].push({
      distributorCode,
      distributorId: distributorId || null,
      distributorName: distributorName || null,
      code: distributorCode,
    });
  }

  return pairingMap;
}
