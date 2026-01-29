import { getTargetUsers } from "./getTargetUsers.js";
import { sendPush } from "./sendPush.js";
import { NOTIFICATION_TEMPLATES } from "../../config/notificationTemplates.js";

/**
 * 🔥 Central dispatcher
 * - respects EVENT_ROLE_MAP
 * - respects notificationPrefs
 * - supports order based routing
 */
export async function dispatchEvent(eventType, payload, context = {}) {
  const users = await getTargetUsers(eventType, context);
  const templates = NOTIFICATION_TEMPLATES[eventType];

  if (!templates) return;

  for (const user of users) {
    const role = String(user.role || "").toUpperCase();
    const templateFn = templates[role];

    if (!templateFn) continue;

    const { title, message } = templateFn(payload);
    const playerIds = user.playerIds || [];

    if (!playerIds.length) continue;

    await sendPush(playerIds, title, message, {
      eventType,
      role,
      userPk: user.pk,
      ...payload,
    });
  }
}
