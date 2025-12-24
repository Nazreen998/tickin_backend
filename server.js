import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { dynamoClient } from "./src/config/dynamo.js";

import authRoutes from "./src/modules/auth/auth.routes.js";
import usersRoutes from "./src/modules/users/users.routes.js";
import dashboardRoutes from "./src/modules/dashboard/dashboard.routes.js";
import ordersRoutes from "./src/modules/orders/orders.routes.js";
import timelineRoutes from "./src/modules/timeline/timeline.routes.js";
import slotRoutes from "./src/modules/slot/slot.routes.js"; // ✅ ESM import
import productsRoutes from "./src/modules/products/products.routes.js";


dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "OK", app: "Tickin Backend" });
});

app.get("/db-test", async (req, res) => {
  try {
    const result = await dynamoClient.send(new ListTablesCommand({}));
    res.json({
      message: "DynamoDB connected successfully",
      tables: result.TableNames,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Routes
app.use("/auth", authRoutes);
app.use("/users", usersRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/orders", ordersRoutes);
app.use("/timeline", timelineRoutes);
app.use("/products", productsRoutes);


// ✅ Slot routes
app.use("/api", slotRoutes);

// ✅ Start server only once
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Tickin API running on port", PORT);
});
