import fs from "fs";
import path from "path";
import xlsx from "xlsx";

export function loadProductsFromExcel(filePath) {
  const finalPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(finalPath)) {
    throw new Error(`Products excel not found: ${finalPath}`);
  }

  const workbook = xlsx.readFile(finalPath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet);

  return rows;
}
