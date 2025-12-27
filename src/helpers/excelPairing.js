import xlsx from "xlsx";
import path from "path";

export function loadDistributorPairingMap(filePath) {
  const fullPath = path.join(process.cwd(), filePath);
  const workbook = xlsx.readFile(fullPath);

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const rows = xlsx.utils.sheet_to_json(sheet);

  const map = {};

  for (const row of rows) {
    const location = String(row["Location"] || row["location"] || "").trim();
    if (!location) continue;

    const distributorName = row["Agency Name"] || row["AgencyName"] || row["agencyName"];
    const area = row["Area"] || row["area"];
    const phone = row["Phone Number"] || row["PhoneNumber"] || row["phone"];

    if (!map[location]) map[location] = [];

    map[location].push({
      distributorId: `${location}-${(distributorName || "").slice(0, 5)}`, // optional temp id
      distributorName: distributorName || "",
      area: area || "",
      phoneNumber: phone || "",
      location,
    });
  }

  return map;
}
