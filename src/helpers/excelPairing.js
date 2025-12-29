import xlsx from "xlsx";
import path from "path";

export function loadDistributorPairingMap(filePath) {
  const fullPath = path.join(process.cwd(), filePath);
  const workbook = xlsx.readFile(fullPath);

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet);

  const map = {};

  for (const row of rows) {
    const location = String(
      row["Location"] ?? row["location"] ?? ""
    ).trim();

    const distributorCode = String(
      row["distributorCode"] ?? row["DistributorCode"] ?? row["distributorCode "] ?? ""
    ).trim();

    const distributorName = String(
      row["Agency Name"] ?? row["AgencyName"] ?? row["agencyName"] ?? ""
    ).trim();

    const area = String(row["Area"] ?? row["area"] ?? "").trim();
    const phoneNumber = String(
      row["Phone Number"] ?? row["PhoneNumber"] ?? row["phone"] ?? ""
    ).trim();

    if (!location || !distributorCode) continue;

    if (!map[location]) map[location] = [];

    map[location].push({
      distributorId: distributorCode,        // ✅ NO SPACE, REAL CODE (D001...)
      distributorName,
      area,
      phoneNumber,
      location,
    });
  }

  return map;
}
