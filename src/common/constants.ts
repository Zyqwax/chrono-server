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
  publicKey: true,
} as const;

/** Mesaj gönderen için hafif seçim */
export const senderSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  publicKey: true,
} as const;

export const messageInclude = {
  sender: { select: senderSelect },
  replyTo: {
    select: {
      id: true,
      content: true,
      ciphertext: true,
      nonce: true,
      senderPublicKey: true,
      type: true,
      deletedAt: true,
      sender: { select: { id: true, displayName: true, username: true, publicKey: true } },
    },
  },
  reactions: {
    select: {
      id: true,
      messageId: true,
      userId: true,
      emoji: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
} as const;

export const makeDmKey = (a: string, b: string) => [a, b].sort().join('_');
