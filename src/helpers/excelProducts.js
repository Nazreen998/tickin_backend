import xlsx from "xlsx";
import path from "path";

export function loadProductsFromExcel(filePath) {
  const fullPath = path.join(process.cwd(), filePath);
  const workbook = xlsx.readFile(fullPath);

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const rows = xlsx.utils.sheet_to_json(sheet);

  const products = rows
    .map((row) => ({
      category: row["Category"] || row["category"] || "",
      productName: row["Product Name"] || row["ProductName"] || "",
      productId: String(row["Product Id"] || row["ProductId"] || "").trim(),
      price: Number(row["Price"] || row["price"] || 0),
      active: true,
    }))
    .filter((p) => p.productId && p.productName && p.price > 0);

  return products;
}
