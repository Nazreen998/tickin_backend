const XLSX = require("xlsx");

/**
 * Adjust these column names based on your excel
 * Example columns:
 *  - distributor_code
 *  - paired_distributor_code
 */
function loadDistributorPairingMap(excelPath) {
  const wb = XLSX.readFile(excelPath);
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const map = {};

  for (const r of rows) {
    // ✅ Change these keys if your excel has different column headers
    const from = (r.distributor_code || r.DIST || r.from || "").toString().trim();
    const to = (r.paired_distributor_code || r.PAIR || r.to || "").toString().trim();

    if (from && to) {
      map[from] = to;
      map[to] = from; // symmetric pairing (optional)
    }
  }

  return map;
}

module.exports = { loadDistributorPairingMap };
