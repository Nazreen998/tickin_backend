import { getTargetUsers } from "./getTargetUsers.js";
import { sendPush } from "./sendPush.js";
import { NOTIFICATION_TEMPLATES } from "../../config/notificationTemplates.js";

export async function dispatchEvent(eventType, payload, context = {}) {
  const users = await getTargetUsers(eventType, context);
  const templates = NOTIFICATION_TEMPLATES[eventType];

  if (!templates) {
    console.warn(`[NOTIFY] No templates for ${eventType}`);
    return;
  }

  console.log(
    `[NOTIFY] ${eventType} → ${users.length} users`
  );

  await Promise.all(
    users.map(async (user) => {
      const role = String(user.role || "").toUpperCase();
      const templateFn = templates[role];
      if (!templateFn) return;

      const playerIds = user.playerIds || [];
      if (!playerIds.length) return;

      const { title, message } = templateFn(payload);

      await sendPush(playerIds, title, message, {
        eventType,
        role,
        userPk: user.pk,
        ...payload,
      });
    })
  );
}
