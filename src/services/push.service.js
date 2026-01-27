import admin from "../config/firebase.js";

export async function sendPush({ user, title, body, data }) {
  if (!user?.fcmToken) {
    console.log("⚠️ No FCM token for user", user?.userId || user?.mobile);
    return;
  }

  const message = {
    token: user.fcmToken,
    notification: {
      title,
      body,
    },
    data: Object.fromEntries(
      Object.entries(data || {}).map(([k, v]) => [k, String(v)])
    ),
  };

  try {
    await admin.messaging().send(message);
    console.log("✅ Push sent to", user.fcmToken);
  } catch (err) {
    console.error("❌ Push failed", err.message);
  }
}
