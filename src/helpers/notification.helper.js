/**
 * Notification preference helpers
 */

/**
 * Get notification prefs for a user safely
 */
export function getUserNotificationPrefs(user) {
  if (!user || !user.role) return [];

  const role = user.role;
  const prefs = user.notificationPrefs?.[role];

  if (!prefs) return [];

  if (Array.isArray(prefs)) return prefs;

  // support "ALL" as string (extra safety)
  if (prefs === "ALL") return ["ALL"];

  return [];
}

/**
 * Check if notification should be sent
 */
export function shouldSendNotification(user, event) {
  const prefs = getUserNotificationPrefs(user);

  if (!prefs.length) return false;
  if (prefs.includes("ALL")) return true;

  return prefs.includes(event);
}
