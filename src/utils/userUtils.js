// src/utils/userUtils.js

export function normalizeUserPk(userId) {
  if (!userId) return null;

  if (userId.startsWith("USER#")) {
    return userId;
  }

  return `USER#${userId}`;
}
