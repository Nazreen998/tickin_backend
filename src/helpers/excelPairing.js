import xlsx from "xlsx";
import path from "path";

export function loadDistributorPairingMap(filePath) {
  const fullPath = path.join(process.cwd(), filePath);
  const workbook = xlsx.readFile(fullPath);

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const rows = xlsx.utils.sheet_to_json(sheet);

  const locationWise = {};
  const distributorWise = {};

  for (const row of rows) {
    const location = String(row["Location"] || row["location"] || "").trim();
    const distributorCode = String(
      row["distributorCode"] ||
      row["DistributorCode"] ||
      row["distributorId"] ||
      row["DistributorId"] ||
      ""
    ).trim();

    if (!location || !distributorCode) continue;

    const distributorName =
      row["Agency Name"] || row["AgencyName"] || row["agencyName"] || "";
    const area = row["Area"] || row["area"] || "";
    const phone = row["Phone Number"] || row["PhoneNumber"] || row["phone"] || "";

    // ✅ 1) Location wise map
    if (!locationWise[location]) locationWise[location] = [];

    locationWise[location].push({
      distributorCode,
      distributorName,
      area,
      phoneNumber: phone,
      location,
    });

    // ✅ 2) Distributor wise map (important for slot booking)
    distributorWise[distributorCode] = {
      distributorCode,
      distributorName,
      area,
      phoneNumber: phone,
      location: Number(location), // slot.service expects number sometimes
    };
  }

  return { locationWise, distributorWise };
}
