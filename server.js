import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import listEndpoints from "express-list-endpoints";

import "./src/appInit.js";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { dynamoClient } from "./src/config/dynamo.js";

// ✅ modules imports
import authRoutes from "./src/modules/auth/auth.routes.js";
import usersRoutes from "./src/modules/users/users.routes.js";
import dashboardRoutes from "./src/modules/dashboard/dashboard.routes.js";
import ordersRoutes from "./src/modules/orders/orders.routes.js";
import timelineRoutes from "./src/modules/timeline/timeline.routes.js";
import slotRoutes from "./src/modules/slot/slot.routes.js";
import productsRoutes from "./src/modules/products/products.routes.js";
import salesRoutes from "./src/modules/sales/sales.routes.js";
import tripsRoutes from "./src/modules/trips/trips.routes.js";
import driverRoutes from "./src/routes/driver.routes.js";

// ✅ goals routes
import goalsRoutes from "./src/routes/goals.routes.js";

dotenv.config();

const app = express();

/**
 * ✅ Important for Render/Railway/Proxy hosting
 */
app.set("trust proxy", 1);

/**
 * ✅ Middleware
 */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * ✅ Root Route
 */
app.get("/", (req, res) => {
  res.send("✅ Tickin Backend is running!");
});

/**
 * ✅ Health Check Route
 */
app.get("/health", (req, res) => {
  res.json({ status: "OK", app: "Tickin Backend" });
});

/**
 * ✅ DynamoDB Connection Test
 */
app.get("/db-test", async (req, res) => {
  try {
    const result = await dynamoClient.send(new ListTablesCommand({}));
    res.json({
      message: "✅ DynamoDB connected successfully",
      tables: result.TableNames,
    });
  } catch (err) {
    console.error("❌ DynamoDB Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ✅ API Routes
 */
app.use("/auth", authRoutes);
app.use("/users", usersRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/orders", ordersRoutes);
app.use("/timeline", timelineRoutes);
app.use("/products", productsRoutes);
// ✅ MOUNT SALES ROUTES
app.use("/api/sales", salesRoutes);
app.use("/api/driver", driverRoutes);

app.use("/trips", tripsRoutes);
app.use("/goals", goalsRoutes);
/**
 * ✅ Slot Routes
 */
app.use("/api", slotRoutes);

/**
 * ✅ 404 Handler
 */
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
    path: req.originalUrl,
  });
});

/**
 * ✅ Global Error Handler
 */
app.use((err, req, res, next) => {
  console.error("❌ Server Error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
  });
});

/**
 * ✅ Start Server
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Tickin API running on port ${PORT}`);

  // ✅ Print all registered endpoints (debug)
  console.log("✅ Registered Endpoints:");
  console.table(
    listEndpoints(app).map((e) => ({
      methods: e.methods.join(","),
      path: e.path,
    }))
  );
});

/**
 * ✅ Prevent server crash on unhandled errors
 */
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});
