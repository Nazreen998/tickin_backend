import axios from "axios";

export async function sendPush(playerIds, title, message, data = {}) {
  if (!playerIds?.length) return;
  if (!title || !message) return;

  await axios.post(
    "https://onesignal.com/api/v1/notifications",
    {
      app_id: process.env.ONESIGNAL_APP_ID,
      include_player_ids: playerIds,
      headings: { en: title },
      contents: { en: message },
      data,
      priority: 10,
    },
    {
      headers: {
        Authorization: `Key ${process.env.ONESIGNAL_REST_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
}
