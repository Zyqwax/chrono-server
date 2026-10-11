/**
 * Ortak yapılandırma ve Prisma seçim (select) şablonları.
 */
export const JWT_SECRET =
  process.env.JWT_SECRET || 'super-secret-chrono-jwt-key-2026';

/** Diğer kullanıcılara gösterilebilecek temel kullanıcı alanları */
export const publicUserSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  status: true,
  lastSeenAt: true,
} as const;

/** Mesaj gönderen için hafif seçim */
export const senderSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

export const messageInclude = {
  sender: { select: senderSelect },
  replyTo: {
    select: {
      id: true,
      content: true,
      type: true,
      deletedAt: true,
      sender: { select: { id: true, displayName: true, username: true } },
    },
  },
} as const;

export const makeDmKey = (a: string, b: string) => [a, b].sort().join('_');
