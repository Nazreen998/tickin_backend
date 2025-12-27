import xlsx from "xlsx";
import path from "path";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../config/dynamo.js";

const PRODUCTS_TABLE = "tickin_products";

// ✅ supports Excel columns: Category, Product Name, Product Id, Price
export async function importProductsFromExcel() {
  const filePath = path.join(process.cwd(), "data", "products.xlsx");

  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const rows = xlsx.utils.sheet_to_json(sheet);

  if (!rows || rows.length === 0) {
    return { ok: false, message: "Excel empty" };
  }

  let added = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // ✅ Your Excel headers
    const name =
      row["Product Name"] ||
      row["productName"] ||
      row["name"] ||
      row["Name"];

    const price = row["Price"] || row["price"];

    const productId =
      row["Product Id"] ||
      row["ProductId"] ||
      row["productId"] ||
      String(1000 + i);

    const category = row["Category"] || row["category"] || null;

    if (!name || !price) continue;

    const item = {
      pk: "PRODUCT",
      sk: `P#${productId}`,
      productId: String(productId),
      name: String(name).trim(),
      price: Number(price),
      category,
      active: row["active"] === false ? false : true,
      createdAt: new Date().toISOString(),
    };

    await ddb.send(
      new PutCommand({
        TableName: PRODUCTS_TABLE,
        Item: item,
      })
    );

    added++;
  }

  return { ok: true, message: "Imported products ✅", added };
}
