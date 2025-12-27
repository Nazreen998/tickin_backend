import { loadDistributorPairingMap } from "./helpers/excelPairing.js";
import { loadProductsFromExcel } from "./helpers/excelProducts.js";
import productRoutes from "./modules/products/products.routes.js";
app.use("/products", productRoutes);

export const pairingMap = loadDistributorPairingMap(
  process.env.PAIRING_EXCEL_PATH || "./data/distributor_location.xlsx"
);

export const productsList = loadProductsFromExcel(
  process.env.PRODUCTS_EXCEL_PATH || "./data/products.xlsx"
);
