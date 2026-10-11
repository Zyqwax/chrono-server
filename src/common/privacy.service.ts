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
   * Karşılıklılık (reciprocal) ilkesi: Viewer kendi çevrimiçi/son görülme durumunu gizlediyse,
   * başkalarının çevrimiçi durumunu da göremez.
   */
  async filterUsers<T extends PublicUser>(viewerId: string, users: T[]): Promise<T[]> {
    if (users.length === 0) return users;
    const ids = [...new Set(users.map((u) => u.id))];
    const [settings, contactRows, viewerSettings, viewerContactRows] = await Promise.all([
      this.prisma.userSettings.findMany({ where: { userId: { in: ids } } }),
      this.prisma.contact.findMany({
        where: { ownerId: { in: ids }, contactId: viewerId },
        select: { ownerId: true },
      }),
      this.getSettings(viewerId),
      this.prisma.contact.findMany({
        where: { ownerId: viewerId, contactId: { in: ids } },
        select: { contactId: true },
      }),
    ]);
    const settingsMap = new Map(settings.map((s) => [s.userId, s]));
    const contactSet = new Set(contactRows.map((c) => c.ownerId));
    const viewerContactSet = new Set(viewerContactRows.map((c) => c.contactId));

    return users.map((u) => {
      const isSelf = u.id === viewerId;
      if (isSelf) return u;

      const s = settingsMap.get(u.id);
      const isContactOfTarget = contactSet.has(u.id);
      const isContactOfViewer = viewerContactSet.has(u.id);

      // 1. Hedef kullanıcının ayarı viewer'a izin veriyor mu?
      const targetAllows = s
        ? this.allowed(s.lastSeenVisibility, isContactOfTarget, false)
        : true;

      // 2. Mütekabiliyet (Reciprocal): Viewer kendi çevrimiçi bilgisini paylaşıyor mu?
      // Kendi bilgisini gizleyen (NOBODY veya uygun olmayan CONTACTS) başkasını da göremez.
      const viewerAllows = this.allowed(
        viewerSettings.lastSeenVisibility,
        isContactOfViewer,
        false,
      );

      const canSeeLastSeen = targetAllows && viewerAllows;

      return {
        ...u,
        avatarUrl: s ? (this.allowed(s.avatarVisibility, isContactOfTarget, false) ? u.avatarUrl : null) : u.avatarUrl,
        bio: s ? (this.allowed(s.bioVisibility, isContactOfTarget, false) ? u.bio : null) : u.bio,
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
