import { Injectable } from '@nestjs/common';
import { Visibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { publicUserSelect } from './constants';

type PublicUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  status: string;
  lastSeenAt: Date | null;
};

/**
 * Kullanıcı gizlilik ayarlarına (son görülme, avatar, hakkında) göre
 * başka bir kullanıcıya gösterilecek profil alanlarını filtreler.
 */
@Injectable()
export class PrivacyService {
  constructor(private prisma: PrismaService) {}

  async getSettings(userId: string) {
    return this.prisma.userSettings.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  }

  /** owner, viewer'ı kişi olarak eklemiş mi? */
  async isContactOf(ownerId: string, viewerId: string) {
    const c = await this.prisma.contact.findUnique({
      where: { ownerId_contactId: { ownerId, contactId: viewerId } },
      select: { id: true },
    });
    return !!c;
  }

  allowed(visibility: Visibility, isContact: boolean, isSelf: boolean) {
    if (isSelf) return true;
    if (visibility === Visibility.EVERYONE) return true;
    if (visibility === Visibility.CONTACTS) return isContact;
    return false;
  }

  /**
   * Birden fazla kullanıcıyı tek seferde viewer'a göre filtreler.
   */
  async filterUsers<T extends PublicUser>(viewerId: string, users: T[]): Promise<T[]> {
    if (users.length === 0) return users;
    const ids = [...new Set(users.map((u) => u.id))];
    const [settings, contactRows] = await Promise.all([
      this.prisma.userSettings.findMany({ where: { userId: { in: ids } } }),
      this.prisma.contact.findMany({
        where: { ownerId: { in: ids }, contactId: viewerId },
        select: { ownerId: true },
      }),
    ]);
    const settingsMap = new Map(settings.map((s) => [s.userId, s]));
    const contactSet = new Set(contactRows.map((c) => c.ownerId));

    return users.map((u) => {
      const s = settingsMap.get(u.id);
      if (!s) return u; // varsayılanlar: herkes görebilir
      const isSelf = u.id === viewerId;
      const isContact = contactSet.has(u.id);
      const canSeeLastSeen = this.allowed(s.lastSeenVisibility, isContact, isSelf);
      return {
        ...u,
        avatarUrl: this.allowed(s.avatarVisibility, isContact, isSelf) ? u.avatarUrl : null,
        bio: this.allowed(s.bioVisibility, isContact, isSelf) ? u.bio : null,
        status: canSeeLastSeen ? u.status : 'HIDDEN',
        lastSeenAt: canSeeLastSeen ? u.lastSeenAt : null,
      };
    });
  }

  async filterUser<T extends PublicUser>(viewerId: string, user: T): Promise<T> {
    const [r] = await this.filterUsers(viewerId, [user]);
    return r;
  }

  async getPublicUser(viewerId: string, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: publicUserSelect,
    });
    if (!user) return null;
    return this.filterUser(viewerId, user);
  }

  /** target'ın ayarı viewer'ın bu işlemi yapmasına izin veriyor mu? */
  async can(
    viewerId: string,
    targetId: string,
    key: 'roomInviteVisibility' | 'callVisibility',
  ) {
    if (viewerId === targetId) return true;
    const s = await this.getSettings(targetId);
    if (s[key] === Visibility.EVERYONE) return true;
    if (s[key] === Visibility.NOBODY) return false;
    return this.isContactOf(targetId, viewerId);
  }

  /**
   * Kullanıcıyla ortak sohbeti olan veya onu kişi olarak eklemiş kullanıcılar.
   * Durum/profil değişiklikleri yalnızca bu kişilere yayınlanır.
   */
  async getRelatedUserIds(userId: string): Promise<string[]> {
    const [members, contactOwners] = await Promise.all([
      this.prisma.roomMember.findMany({
        where: { room: { members: { some: { userId } } }, userId: { not: userId } },
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.prisma.contact.findMany({
        where: { contactId: userId },
        select: { ownerId: true },
      }),
    ]);
    return [
      ...new Set([
        ...members.map((m) => m.userId),
        ...contactOwners.map((c) => c.ownerId),
      ]),
    ];
  }
}
