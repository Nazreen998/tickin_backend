import express from "express";
import cors from "cors";
import dotenv from "dotenv";

// ✅ Load env FIRST
dotenv.config();

// ✅ appInit runs after dotenv
import "./src/appInit.js";

// ✅ Dynamo imports AFTER env
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
import goalsRoutes from "./src/routes/goals.routes.js";
import distributorRoutes from "./src/modules/distributors/distributors.routes.js";
import vehiclesRoutes from "./src/routes/vehicles.routes.js";
import attendanceRoutes from "./src/modules/attendance/attendance.routes.js";
// ✅ FIXED ✅
// Import ManagerOrdersFlow as router
import ManagerOrdersFlowRoutes from "./src/routes/managerOrdersFlow.routes.js";
import attendanceDashboardRoutes from "./src/modules/attendance/dashboard.routes.js";
import attendanceConfigRoutes from "./src/modules/attendance/config.routes.js";

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
 * ✅ API Routes (✅ ALL under /api)
 */
app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/timeline", timelineRoutes);
app.use("/api/products", productsRoutes);

app.use("/api/sales", salesRoutes);
app.use("/api/driver", driverRoutes);

app.use("/api/trips", tripsRoutes);
app.use("/api/goals", goalsRoutes);

app.use("/api/distributors", distributorRoutes);
app.use("/api/vehicles", vehiclesRoutes);

/**
 * ✅ Manager Orders Flow Route ✅
 */
app.use("/api/manager-orders-flow", ManagerOrdersFlowRoutes);

/**
 * ✅ Slot Routes
 */
app.use("/api/slots", slotRoutes);

/**
 * ✅ Attendance  Routes
 */
app.use("/api/attendance", attendanceRoutes);
app.use("/api/attendance/dashboard", attendanceDashboardRoutes);
app.use("/api/attendance/config", attendanceConfigRoutes);



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
 * ✅ Custom Endpoint Printer (works on all express versions)
 */
function printRoutes(app) {
  try {
    const stack = app?.router?.stack || app?._router?.stack || [];
    const routes = [];

    stack.forEach((layer) => {
      if (layer.route && layer.route.path) {
        const methods = Object.keys(layer.route.methods || {})
          .map((m) => m.toUpperCase())
          .join(",");
        routes.push({ methods, path: layer.route.path });
      }

      if (layer.name === "router" && layer.handle?.stack) {
        layer.handle.stack.forEach((handler) => {
          if (handler.route && handler.route.path) {
            const methods = Object.keys(handler.route.methods || {})
              .map((m) => m.toUpperCase())
              .join(",");
            routes.push({ methods, path: handler.route.path });
          }
        });
      }
    });

    console.log("✅ Registered Endpoints:");
    console.table(
      routes.length
        ? routes
        : [{ methods: "-", path: "No routes detected (but API can still work)" }]
    );
  } catch (e) {
    console.log("⚠️ Endpoint list print failed (not a blocker):", e.message);
  }
}

/**
 * ✅ Start Server
 */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Tickin API running on port ${PORT}`);

  // ✅ Print endpoints (safe)
  printRoutes(app);
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
