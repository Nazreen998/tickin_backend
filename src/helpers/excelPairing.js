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
    const distributorCode = String(row["distributorCode"] || "").trim();

    if (!location || !distributorCode) continue;

    const distributorName = row["Agency Name"] || "";
    const area = row["Area"] || "";
    const phone = row["Phone Number"] || "";

    // ✅ location wise map for sales/home
    if (!locationWise[location]) locationWise[location] = [];

    locationWise[location].push({
      distributorCode,
      distributorName,
      area,
      phoneNumber: phone,
      location,
    });

    // ✅ distributor wise map for slot booking
    distributorWise[distributorCode] = {
      distributorCode,
      distributorName,
      area,
      phoneNumber: phone,
      location: Number(location),
    };
  }

  return { locationWise, distributorWise };
}
