import express from "express";
import { getDrivers } from "./users.service.js";
import { verifyToken } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.get("/drivers", getDrivers);
/**
 * ✅ Save / Update FCM Token
 */
router.post("/save-fcm-token", verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({
        ok: false,
        message: "fcmToken required",
      });
    }

    await ddb.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: {
          pk: `USER#${user.mobile}`,
          sk: "PROFILE",
        },
        UpdateExpression: `
          SET fcmToken = :t,
              fcmUpdatedAt = :u
        `,
        ExpressionAttributeValues: {
          ":t": fcmToken,
          ":u": new Date().toISOString(),
        },
      })
    );

    return res.json({
      ok: true,
      message: "✅ FCM token saved",
    });
  } catch (err) {
    console.error("save-fcm-token error:", err);
    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
});

export default router;
