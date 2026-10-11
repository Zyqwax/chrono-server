import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MessageType, Prisma, Role, RoomType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../common/realtime.service';
import { PrivacyService } from '../common/privacy.service';
import {
  makeDmKey,
  messageInclude,
  publicUserSelect,
} from '../common/constants';
import { CloudinaryService } from '../common/cloudinary.service';
import {
  CreateRoomDto,
  UpdateMembershipDto,
  UpdateRoomDto,
} from './dto/rooms.dto';

const roomListInclude = {
  room: {
    include: {
      members: {
        include: { user: { select: publicUserSelect } },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: messageInclude,
      },
    },
  },
} satisfies Prisma.RoomMemberInclude;

type MembershipWithRoom = Prisma.RoomMemberGetPayload<{
  include: typeof roomListInclude;
}>;

/** Silinmiş mesajların içeriğini istemciye göndermeden önce temizler */
export function sanitizeMessage<T extends { deletedAt: Date | null; content: string }>(
  m: T,
): T {
  if (!m.deletedAt) return m;
  return { ...m, content: '' };
}

@Injectable()
export class RoomsService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private privacy: PrivacyService,
    private cloudinary: CloudinaryService,
  ) {}

  // ------------------------------------------------------------------
  // Yardımcılar
  // ------------------------------------------------------------------

  async requireMembership(userId: string, roomId: string) {
    const membership = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      include: { room: true },
    });
    if (!membership) {
      throw new ForbiddenException('Bu sohbete erişim yetkiniz yok');
    }
    return membership;
  }

  async getMemberIds(roomId: string) {
    const rows = await this.prisma.roomMember.findMany({
      where: { roomId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  async createSystemMessage(roomId: string, actorId: string, content: string) {
    const message = await this.prisma.message.create({
      data: { roomId, senderId: actorId, content, type: MessageType.SYSTEM },
      include: messageInclude,
    });
    await this.prisma.room.update({
      where: { id: roomId },
      data: { lastMessageAt: message.createdAt },
    });
    const memberIds = await this.getMemberIds(roomId);
    this.realtime.toUsers(memberIds, 'new_message', message);
    return message;
  }

  private async buildSummaries(userId: string, memberships: MembershipWithRoom[]) {
    if (memberships.length === 0) return [];
    const now = new Date();

    // Okundu bilgisini kapatmış kullanıcılar
    const allMemberIds = [
      ...new Set(memberships.flatMap((m) => m.room.members.map((x) => x.userId))),
    ];
    const noReceipts = new Set(
      (
        await this.prisma.userSettings.findMany({
          where: { userId: { in: allMemberIds }, readReceipts: false },
          select: { userId: true },
        })
      ).map((s) => s.userId),
    );

    // DM karşı taraflarını gizliliğe göre filtrele
    const peers = memberships
      .filter((m) => m.room.type === RoomType.DIRECT)
      .map((m) => m.room.members.find((x) => x.userId !== userId)?.user)
      .filter((u): u is NonNullable<typeof u> => !!u);
    const filteredPeers = new Map(
      (await this.privacy.filterUsers(userId, peers)).map((u) => [
        u.id,
        {
          ...u,
          status:
            (u.status as string) === 'HIDDEN'
              ? 'HIDDEN'
              : this.realtime.isOnline(u.id)
                ? 'ONLINE'
                : 'OFFLINE',
        },
      ]),
    );

    return Promise.all(
      memberships.map(async (m) => {
        const room = m.room;
        const since = [m.lastReadAt, m.clearedAt, m.joinedAt]
          .filter((d): d is Date => !!d)
          .reduce((a, b) => (a > b ? a : b));

        const unreadCount = await this.prisma.message.count({
          where: {
            roomId: room.id,
            senderId: { not: userId },
            deletedAt: null,
            createdAt: { gt: since },
          },
        });

        let lastMessage: (typeof room.messages)[0] | null =
          room.messages[0] ?? null;
        if (lastMessage && m.clearedAt && lastMessage.createdAt <= m.clearedAt) {
          lastMessage = null;
        }

        const others = room.members.filter((x) => x.userId !== userId);
        let othersReadAt: Date | null = null;
        if (room.type === RoomType.ROOM) {
          // Oda sohbetlerinde okundu bilgisi kapatma geçerli olmaz
          othersReadAt = others
            .map((x) => x.lastReadAt as Date)
            .filter(Boolean)
            .reduce<Date | null>((a, b) => (!a || b > a ? b : a), null);
        } else {
          // Birebir (DM): Kapatan kişi ne karşıya gönderir ne de karşıdan alır
          const iDisabled = noReceipts.has(userId);
          const peerDisabled = others.some((x) => noReceipts.has(x.userId));
          if (!iDisabled && !peerDisabled) {
            othersReadAt = others[0]?.lastReadAt ?? null;
          }
        }

        const peerRaw =
          room.type === RoomType.DIRECT ? others[0]?.user ?? null : null;

        return {
          id: room.id,
          type: room.type,
          name: room.name,
          iconUrl: room.iconUrl,
          description: room.description,
          createdById: room.createdById,
          createdAt: room.createdAt,
          updatedAt: room.updatedAt,
          lastMessageAt: room.lastMessageAt,
          membersCount: room.members.length,
          onlineCount: room.members.filter((x) => this.realtime.isOnline(x.userId)).length,
          peer: peerRaw
            ? filteredPeers.get(peerRaw.id) ?? { ...peerRaw, status: 'HIDDEN', lastSeenAt: null }
            : null,
          lastMessage: lastMessage ? sanitizeMessage(lastMessage) : null,
          unreadCount,
          isPinned: m.isPinned,
          isArchived: m.isArchived,
          mutedUntil: m.mutedUntil,
          isMuted: !!m.mutedUntil && m.mutedUntil > now,
          myRole: m.role,
          lastReadAt: m.lastReadAt,
          othersReadAt,
        };
      }),
    );
  }

  async getRoomSummary(userId: string, roomId: string) {
    const membership = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      include: roomListInclude,
    });
    if (!membership) return null;
    const [summary] = await this.buildSummaries(userId, [membership]);
    return summary;
  }

  /** Odayı ilgili kullanıcıların listesine canlı olarak ekler */
  async pushRoomToUsers(roomId: string, userIds: string[]) {
    for (const uid of userIds) {
      const summary = await this.getRoomSummary(uid, roomId);
      if (summary) this.realtime.toUser(uid, 'room_upsert', summary);
    }
  }

  // ------------------------------------------------------------------
  // Liste & detay
  // ------------------------------------------------------------------

  async getUserRooms(userId: string) {
    const memberships = await this.prisma.roomMember.findMany({
      where: { userId, hidden: false },
      include: roomListInclude,
    });
    const summaries = await this.buildSummaries(userId, memberships);
    return summaries.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      const ta = (a.lastMessageAt ?? a.createdAt).getTime();
      const tb = (b.lastMessageAt ?? b.createdAt).getTime();
      return tb - ta;
    });
  }

  async getRoomDetails(userId: string, roomId: string) {
    const membership = await this.requireMembership(userId, roomId);

    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      include: {
        createdBy: { select: publicUserSelect },
        members: {
          include: { user: { select: publicUserSelect } },
          orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
        },
      },
    });
    if (!room) throw new NotFoundException('Sohbet bulunamadı');

    const filtered = await this.privacy.filterUsers(
      userId,
      room.members.map((m) => m.user),
    );
    const fMap = new Map(
      filtered.map((u) => [
        u.id,
        {
          ...u,
          status:
            (u.status as string) === 'HIDDEN'
              ? 'HIDDEN'
              : this.realtime.isOnline(u.id)
                ? 'ONLINE'
                : 'OFFLINE',
        },
      ]),
    );
    const members = room.members.map((m) => ({
      id: m.id,
      roomId: m.roomId,
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt,
      user: fMap.get(m.userId) ?? m.user,
    }));

    const summary = await this.getRoomSummary(userId, roomId);

    return {
      ...summary,
      createdBy: room.createdBy,
      members,
      myRole: membership.role,
      peer:
        room.type === RoomType.DIRECT
          ? members.find((m) => m.userId !== userId)?.user ?? null
          : null,
    };
  }

  // ------------------------------------------------------------------
  // Oluşturma
  // ------------------------------------------------------------------

  async createRoom(userId: string, dto: CreateRoomDto) {
    const memberIds = [...new Set((dto.memberIds ?? []).filter((id) => id !== userId))];

    // Davet gizliliği
    const allowedIds: string[] = [];
    for (const id of memberIds) {
      if (await this.privacy.can(userId, id, 'roomInviteVisibility')) {
        allowedIds.push(id);
      }
    }

    const room = await this.prisma.room.create({
      data: {
        type: RoomType.ROOM,
        name: dto.name.trim(),
        iconUrl: dto.iconUrl,
        description: dto.description?.trim() || '',
        createdById: userId,
        lastMessageAt: new Date(),
        members: {
          create: [
            { userId, role: Role.ADMIN, lastReadAt: new Date() },
            ...allowedIds.map((id) => ({ userId: id, role: Role.MEMBER })),
          ],
        },
      },
    });

    const creator = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true },
    });
    await this.createSystemMessage(
      room.id,
      userId,
      `${creator?.displayName ?? 'Bir kullanıcı'} "${room.name}" sohbet odasını oluşturdu`,
    );

    await this.pushRoomToUsers(room.id, [userId, ...allowedIds]);

    const summary = await this.getRoomSummary(userId, room.id);
    return {
      ...summary,
      skippedMemberIds: memberIds.filter((id) => !allowedIds.includes(id)),
    };
  }

  /** DM'i aç: varsa döndür, yoksa oluştur. Karşı tarafa ilk mesaj gelene kadar gizli kalır. */
  async openDirect(userId: string, targetId: string) {
    if (userId === targetId) {
      throw new BadRequestException('Kendinizle sohbet başlatamazsınız');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('Kullanıcı bulunamadı');

    const dmKey = makeDmKey(userId, targetId);
    let room = await this.prisma.room.findUnique({ where: { dmKey } });

    if (!room) {
      try {
        room = await this.prisma.room.create({
          data: {
            type: RoomType.DIRECT,
            dmKey,
            createdById: userId,
            members: {
              create: [
                { userId, role: Role.MEMBER, lastReadAt: new Date() },
                { userId: targetId, role: Role.MEMBER, hidden: true },
              ],
            },
          },
        });
      } catch (err) {
        // Eşzamanlı oluşturma yarışı
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          room = await this.prisma.room.findUnique({ where: { dmKey } });
        } else {
          throw err;
        }
      }
    } else {
      // Daha önce "sil" denmişse listeye geri getir
      await this.prisma.roomMember.updateMany({
        where: { roomId: room.id, userId, hidden: true },
        data: { hidden: false },
      });
    }

    const summary = await this.getRoomSummary(userId, room!.id);
    this.realtime.toUser(userId, 'room_upsert', summary);
    return summary;
  }

  // ------------------------------------------------------------------
  // Güncelleme / silme
  // ------------------------------------------------------------------

  async updateRoom(userId: string, roomId: string, dto: UpdateRoomDto) {
    const membership = await this.requireMembership(userId, roomId);
    if (membership.room.type === RoomType.DIRECT) {
      throw new BadRequestException('Birebir sohbetlerin bilgileri değiştirilemez');
    }
    if (membership.role !== Role.ADMIN) {
      throw new ForbiddenException('Sadece yöneticiler sohbet odası bilgilerini değiştirebilir');
    }

    const before = membership.room;
    await this.prisma.room.update({
      where: { id: roomId },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.iconUrl !== undefined ? { iconUrl: dto.iconUrl } : {}),
        ...(dto.description !== undefined ? { description: dto.description.trim() } : {}),
      },
    });

    if (dto.name && dto.name.trim() !== before.name) {
      const actor = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { displayName: true },
      });
      await this.createSystemMessage(
        roomId,
        userId,
        `${actor?.displayName} sohbet odasının adını "${dto.name.trim()}" olarak değiştirdi`,
      );
    }

    const memberIds = await this.getMemberIds(roomId);
    await this.pushRoomToUsers(roomId, memberIds);
    return this.getRoomSummary(userId, roomId);
  }

  async uploadTempIcon(userId: string, file: Express.Multer.File) {
    if (!file || !file.buffer) {
      throw new BadRequestException('Lütfen geçerli bir görsel dosyası seçin');
    }
    const publicId = `room_icon_${userId}_${Date.now()}`;
    const result = await this.cloudinary.uploadImage(file.buffer, 'rooms', publicId);
    return { iconUrl: result.secure_url };
  }

  async uploadRoomIcon(userId: string, roomId: string, file: Express.Multer.File) {
    const membership = await this.requireMembership(userId, roomId);
    if (membership.room.type === RoomType.DIRECT) {
      throw new BadRequestException('Birebir sohbetlerin simgesi değiştirilemez');
    }
    if (membership.role !== Role.ADMIN) {
      throw new ForbiddenException('Sadece yöneticiler sohbet odası simgesini değiştirebilir');
    }
    if (!file || !file.buffer) {
      throw new BadRequestException('Lütfen geçerli bir görsel dosyası seçin');
    }

    const publicId = `room_${roomId}_${Date.now()}`;
    const result = await this.cloudinary.uploadImage(file.buffer, 'rooms', publicId);

    const oldIcon = membership.room.iconUrl;
    if (oldIcon) {
      await this.cloudinary.deleteImage(oldIcon);
    }

    await this.prisma.room.update({
      where: { id: roomId },
      data: { iconUrl: result.secure_url },
    });

    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true },
    });
    await this.createSystemMessage(
      roomId,
      userId,
      `${actor?.displayName || 'Bir kullanıcı'} sohbet odasının simgesini güncelledi`,
    );

    const memberIds = await this.getMemberIds(roomId);
    await this.pushRoomToUsers(roomId, memberIds);
    return this.getRoomSummary(userId, roomId);
  }

  async removeRoomIcon(userId: string, roomId: string) {
    const membership = await this.requireMembership(userId, roomId);
    if (membership.room.type === RoomType.DIRECT) {
      throw new BadRequestException('Birebir sohbetlerin simgesi değiştirilemez');
    }
    if (membership.role !== Role.ADMIN) {
      throw new ForbiddenException('Sadece yöneticiler sohbet odası simgesini kaldırabilir');
    }

    if (membership.room.iconUrl) {
      await this.cloudinary.deleteImage(membership.room.iconUrl);
    }

    await this.prisma.room.update({
      where: { id: roomId },
      data: { iconUrl: null },
    });

    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true },
    });
    await this.createSystemMessage(
      roomId,
      userId,
      `${actor?.displayName || 'Bir kullanıcı'} sohbet odasının simgesini kaldırdı`,
    );

    const memberIds = await this.getMemberIds(roomId);
    await this.pushRoomToUsers(roomId, memberIds);
    return this.getRoomSummary(userId, roomId);
  }

  async deleteRoom(userId: string, roomId: string, forEveryone = false) {
    const membership = await this.requireMembership(userId, roomId);
    const memberIds = await this.getMemberIds(roomId);

    if (membership.room.type === RoomType.DIRECT) {
      if (forEveryone) {
        await this.prisma.room.delete({ where: { id: roomId } });
        this.realtime.toUsers(memberIds, 'room_removed', { roomId });
      } else {
        // Yalnızca benim için: geçmişi temizle ve listeden gizle
        await this.prisma.roomMember.update({
          where: { id: membership.id },
          data: { clearedAt: new Date(), hidden: true, isPinned: false },
        });
        this.realtime.toUser(userId, 'room_removed', { roomId });
      }
      return { success: true };
    }

    if (membership.role !== Role.ADMIN) {
      throw new ForbiddenException('Sadece yöneticiler sohbet odasını silebilir');
    }
    if (membership.room.iconUrl) {
      await this.cloudinary.deleteImage(membership.room.iconUrl);
    }
    await this.prisma.room.delete({ where: { id: roomId } });
    this.realtime.toUsers(memberIds, 'room_removed', { roomId });
    return { success: true };
  }

  async clearHistory(userId: string, roomId: string) {
    const membership = await this.requireMembership(userId, roomId);
    await this.prisma.roomMember.update({
      where: { id: membership.id },
      data: { clearedAt: new Date() },
    });
    const summary = await this.getRoomSummary(userId, roomId);
    this.realtime.toUser(userId, 'room_upsert', summary);
    return { success: true };
  }

  async leaveRoom(userId: string, roomId: string) {
    const membership = await this.requireMembership(userId, roomId);
    if (membership.room.type === RoomType.DIRECT) {
      return this.deleteRoom(userId, roomId, false);
    }

    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true },
    });

    await this.prisma.roomMember.delete({ where: { id: membership.id } });
    this.realtime.toUser(userId, 'room_removed', { roomId });
    this.realtime.leaveUserFrom(userId, `room:${roomId}`);

    const remaining = await this.prisma.roomMember.findMany({
      where: { roomId },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    });

    if (remaining.length === 0) {
      await this.prisma.room.delete({ where: { id: roomId } });
      return { success: true };
    }

    // Yönetici kalmadıysa en eski üyeyi yönetici yap
    if (!remaining.some((m) => m.role === Role.ADMIN)) {
      await this.prisma.roomMember.update({
        where: { id: remaining[0].id },
        data: { role: Role.ADMIN },
      });
    }
    if (membership.room.createdById === userId) {
      const heir = remaining.find((m) => m.role === Role.ADMIN) ?? remaining[0];
      await this.prisma.room.update({
        where: { id: roomId },
        data: { createdById: heir.userId },
      });
    }

    await this.createSystemMessage(
      roomId,
      remaining[0].userId,
      `${actor?.displayName} sohbet odasından ayrıldı`,
    );
    await this.pushRoomToUsers(
      roomId,
      remaining.map((m) => m.userId),
    );
    return { success: true };
  }

  // ------------------------------------------------------------------
  // Üyeler
  // ------------------------------------------------------------------

  async addMembers(userId: string, roomId: string, userIds: string[]) {
    const membership = await this.requireMembership(userId, roomId);
    if (membership.room.type === RoomType.DIRECT) {
      throw new BadRequestException('Birebir sohbete üye eklenemez');
    }

    const existing = new Set(await this.getMemberIds(roomId));
    const candidates = [...new Set(userIds)].filter((id) => !existing.has(id));
    if (candidates.length === 0) {
      throw new BadRequestException('Seçilen kullanıcılar zaten bu sohbet odasında');
    }

    const added: string[] = [];
    const skipped: string[] = [];
    for (const id of candidates) {
      if (await this.privacy.can(userId, id, 'roomInviteVisibility')) added.push(id);
      else skipped.push(id);
    }
    if (added.length === 0) {
      throw new ForbiddenException(
        'Bu kullanıcılar gizlilik ayarları nedeniyle sohbet odalarına eklenemiyor',
      );
    }

    await this.prisma.roomMember.createMany({
      data: added.map((id) => ({ roomId, userId: id, role: Role.MEMBER })),
      skipDuplicates: true,
    });

    const [actor, addedUsers] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } }),
      this.prisma.user.findMany({
        where: { id: { in: added } },
        select: { displayName: true },
      }),
    ]);
    await this.createSystemMessage(
      roomId,
      userId,
      `${actor?.displayName}, ${addedUsers.map((u) => u.displayName).join(', ')} kişisini ekledi`,
    );

    const memberIds = await this.getMemberIds(roomId);
    await this.pushRoomToUsers(roomId, memberIds);
    return { added, skipped };
  }

  async removeMember(userId: string, roomId: string, targetUserId: string) {
    if (userId === targetUserId) return this.leaveRoom(userId, roomId);

    const membership = await this.requireMembership(userId, roomId);
    if (membership.room.type === RoomType.DIRECT) {
      throw new BadRequestException('Birebir sohbetten üye çıkarılamaz');
    }
    if (membership.role !== Role.ADMIN) {
      throw new ForbiddenException('Sadece yöneticiler üyeleri çıkarabilir');
    }
    if (targetUserId === membership.room.createdById) {
      throw new ForbiddenException('Sohbet odasının kurucusu çıkarılamaz');
    }

    const target = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId: targetUserId } },
      include: { user: { select: { displayName: true } } },
    });
    if (!target) throw new NotFoundException('Üye bulunamadı');

    await this.prisma.roomMember.delete({ where: { id: target.id } });
    this.realtime.toUser(targetUserId, 'room_removed', { roomId });
    this.realtime.leaveUserFrom(targetUserId, `room:${roomId}`);

    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true },
    });
    await this.createSystemMessage(
      roomId,
      userId,
      `${actor?.displayName}, ${target.user.displayName} kişisini çıkardı`,
    );
    const memberIds = await this.getMemberIds(roomId);
    await this.pushRoomToUsers(roomId, memberIds);
    return { success: true };
  }

  async setMemberRole(userId: string, roomId: string, targetUserId: string, role: Role) {
    const membership = await this.requireMembership(userId, roomId);
    if (membership.room.type === RoomType.DIRECT) {
      throw new BadRequestException('Birebir sohbette rol yoktur');
    }
    if (membership.role !== Role.ADMIN) {
      throw new ForbiddenException('Sadece yöneticiler rol değiştirebilir');
    }
    if (targetUserId === membership.room.createdById && role !== Role.ADMIN) {
      throw new ForbiddenException('Kurucunun yöneticiliği alınamaz');
    }
    await this.prisma.roomMember.update({
      where: { roomId_userId: { roomId, userId: targetUserId } },
      data: { role },
    });
    const memberIds = await this.getMemberIds(roomId);
    this.realtime.toUsers(memberIds, 'room_members_changed', { roomId });
    await this.pushRoomToUsers(roomId, [targetUserId]);
    return { success: true };
  }

  // ------------------------------------------------------------------
  // Kişisel tercihler & okundu
  // ------------------------------------------------------------------

  async updateMembership(userId: string, roomId: string, dto: UpdateMembershipDto) {
    const membership = await this.requireMembership(userId, roomId);
    await this.prisma.roomMember.update({
      where: { id: membership.id },
      data: {
        ...(dto.isPinned !== undefined ? { isPinned: dto.isPinned } : {}),
        ...(dto.isArchived !== undefined
          ? { isArchived: dto.isArchived, ...(dto.isArchived ? { isPinned: false } : {}) }
          : {}),
        ...(dto.mutedUntil !== undefined
          ? { mutedUntil: dto.mutedUntil ? new Date(dto.mutedUntil) : null }
          : {}),
      },
    });
    const summary = await this.getRoomSummary(userId, roomId);
    this.realtime.toUser(userId, 'room_upsert', summary);
    return summary;
  }

  async markRead(userId: string, roomId: string) {
    const membership = await this.requireMembership(userId, roomId);
    const readAt = new Date();
    await this.prisma.roomMember.update({
      where: { id: membership.id },
      data: { lastReadAt: readAt },
    });

    // Kendi diğer cihazlarım: okunmamış sayısını sıfırla
    this.realtime.toUser(userId, 'room_read', { roomId, unreadCount: 0 });

    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: { type: true },
    });
    const isRoom = room?.type === RoomType.ROOM;
    const settings = await this.privacy.getSettings(userId);

    // Oda sohbetlerinde okundu bilgisi kapatma geçerli olmaz; her zaman yayınlanır
    if (isRoom) {
      const memberIds = (await this.getMemberIds(roomId)).filter((id) => id !== userId);
      this.realtime.toUsers(memberIds, 'messages_read', { roomId, userId, readAt });
    } else {
      // DM: Okundu bilgisini kapatan kişi ne karşıya okundu bilgisi gönderir ne de karşıdan alır
      if (settings.readReceipts) {
        const memberIds = (await this.getMemberIds(roomId)).filter((id) => id !== userId);
        const peerId = memberIds[0];
        if (peerId) {
          const peerSettings = await this.privacy.getSettings(peerId);
          if (peerSettings.readReceipts) {
            this.realtime.toUser(peerId, 'messages_read', { roomId, userId, readAt });
          }
        }
      }
    }
    return { success: true, readAt };
  }
}
