import { RoomType } from '@prisma/client';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../common/cloudinary.service';
import { RealtimeService } from '../common/realtime.service';
import { PrivacyService } from '../common/privacy.service';
import { makeDmKey, publicUserSelect } from '../common/constants';
import {
  ChangePasswordDto,
  UpdateProfileDto,
  UpdateSettingsDto,
} from './dto/users.dto';

export const meSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  birthday: true,
  status: true,
  pushToken: true,
  lastSeenAt: true,
  publicKey: true,
  encryptedPrivateKey: true,
  keyBackupSalt: true,
  keyBackupNonce: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private cloudinary: CloudinaryService,
    private realtime: RealtimeService,
    private privacy: PrivacyService,
  ) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: meSelect,
    });
    if (!user) throw new UnauthorizedException('Kullanıcı bulunamadı');
    return user;
  }

  async updateMe(userId: string, dto: UpdateProfileDto) {
    if (dto.username) {
      const username = dto.username.toLowerCase();
      const taken = await this.prisma.user.findFirst({
        where: { username, id: { not: userId } },
        select: { id: true },
      });
      if (taken) throw new ConflictException('Bu kullanıcı adı zaten alınmış');
      dto.username = username;
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.displayName !== undefined ? { displayName: dto.displayName.trim() } : {}),
        ...(dto.username !== undefined ? { username: dto.username } : {}),
        ...(dto.bio !== undefined ? { bio: dto.bio.trim() } : {}),
        ...(dto.birthday !== undefined
          ? { birthday: dto.birthday ? new Date(dto.birthday) : null }
          : {}),
      },
      select: meSelect,
    });

    await this.broadcastProfile(userId);
    return user;
  }

  async checkUsername(userId: string, username: string) {
    const clean = (username || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(clean)) {
      return { available: false, reason: 'invalid' };
    }
    const existing = await this.prisma.user.findUnique({
      where: { username: clean },
      select: { id: true },
    });
    return {
      available: !existing || existing.id === userId,
      reason: existing && existing.id !== userId ? 'taken' : null,
    };
  }

  async uploadAvatar(userId: string, file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Dosya bulunamadı');
    if (!file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Yalnızca resim dosyaları yüklenebilir');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        avatarUrl: true,
        avatarPublicId: true,
        avatarUpdateCount: true,
        avatarLastUpdatedAt: true,
      },
    });

    if (!user) throw new NotFoundException('Kullanıcı bulunamadı');

    // Günlük Rate Limit Kontrolü (Günde en fazla 2 kez)
    const now = new Date();
    let count = user.avatarUpdateCount;

    if (user.avatarLastUpdatedAt) {
      const isSameDay =
        user.avatarLastUpdatedAt.toDateString() === now.toDateString();
      if (!isSameDay) {
        count = 0; // Yeni gün, sayaç sıfırlanır
      }
    } else {
      count = 0;
    }

    if (count >= 2) {
      throw new BadRequestException(
        'Profil fotoğrafınızı günde en fazla 2 kez değiştirebilirsiniz. Lütfen yarın tekrar deneyin.',
      );
    }

    // 1. Yeni avatarı benzersiz bir publicId ile yükle
    const newPublicId = `user_${userId}_${Date.now()}`;
    const result = await this.cloudinary.uploadImage(
      file.buffer,
      'avatars',
      newPublicId,
    );

    // 2. Önceki bir avatar varsa Cloudinary'den temizle (ikinci avatar yüklenince birinci silinsin)
    const oldAvatarIdentifier = user.avatarPublicId || user.avatarUrl;
    if (oldAvatarIdentifier) {
      await this.cloudinary.deleteImage(oldAvatarIdentifier);
    }

    // 3. Veritabanını güncelle
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        avatarUrl: result.secure_url,
        avatarPublicId: result.public_id,
        avatarUpdateCount: count + 1,
        avatarLastUpdatedAt: now,
      },
      select: meSelect,
    });

    await this.broadcastProfile(userId);
    return updatedUser;
  }

  async removeAvatar(userId: string) {
    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarPublicId: true, avatarUrl: true },
    });
    const oldAvatarIdentifier = current?.avatarPublicId || current?.avatarUrl;
    if (oldAvatarIdentifier) {
      await this.cloudinary.deleteImage(oldAvatarIdentifier);
    }
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: null, avatarPublicId: null },
      select: meSelect,
    });
    await this.broadcastProfile(userId);
    return user;
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Kullanıcı bulunamadı');
    const ok = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!ok) throw new BadRequestException('Mevcut şifre hatalı');
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('Yeni şifre eskisiyle aynı olamaz');
    }
    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    return { success: true };
  }

  async deleteAccount(userId: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Kullanıcı bulunamadı');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new BadRequestException('Şifre hatalı');

    const avatarToDelete = user.avatarPublicId || user.avatarUrl;
    if (avatarToDelete) await this.cloudinary.deleteImage(avatarToDelete);

    const related = await this.privacy.getRelatedUserIds(userId);

    // Başka üyeleri olan sohbet odalarının sahipliğini devret (aksi halde cascade ile silinirdi)
    const ownedRooms = await this.prisma.room.findMany({
      where: { createdById: userId, type: 'ROOM' },
      select: {
        id: true,
        members: {
          where: { userId: { not: userId } },
          orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
          take: 1,
        },
      },
    });
    for (const room of ownedRooms) {
      const heir = room.members[0];
      if (!heir) continue;
      await this.prisma.$transaction([
        this.prisma.room.update({ where: { id: room.id }, data: { createdById: heir.userId } }),
        this.prisma.roomMember.update({ where: { id: heir.id }, data: { role: 'ADMIN' } }),
      ]);
    }

    // DM'ler ve tek kişilik odalar cascade ile silinir
    await this.prisma.room.deleteMany({
      where: { type: 'DIRECT', members: { some: { userId } } },
    });
    await this.prisma.user.delete({ where: { id: userId } });
    this.realtime.toUsers(related, 'user_deleted', { userId });
    return { success: true };
  }

  async getSettings(userId: string) {
    return this.privacy.getSettings(userId);
  }

  async updateSettings(userId: string, dto: UpdateSettingsDto) {
    await this.privacy.getSettings(userId); // yoksa oluştur
    const settings = await this.prisma.userSettings.update({
      where: { userId },
      data: dto,
    });

    // 1. Profil ve son görülme gizliliği değiştiğinde
    const privacyKeys: (keyof UpdateSettingsDto)[] = [
      'lastSeenVisibility',
      'avatarVisibility',
      'bioVisibility',
    ];
    if (privacyKeys.some((k) => dto[k] !== undefined)) {
      await this.broadcastProfile(userId);

      // Mütekabiliyet: Kullanıcının kendi DM odalarındaki karşı taraf durumlarını da anında güncelle
      if (dto.lastSeenVisibility !== undefined) {
        const directMemberships = await this.prisma.roomMember.findMany({
          where: { userId, room: { type: RoomType.DIRECT } },
          include: {
            room: {
              include: {
                members: {
                  include: { user: { select: publicUserSelect } },
                },
              },
            },
          },
        });

        for (const m of directMemberships) {
          const peer = m.room.members.find((x) => x.userId !== userId)?.user;
          if (!peer) continue;
          const filtered = await this.privacy.filterUser(userId, peer);
          const isOnline = this.realtime.isOnline(peer.id);
          const finalStatus =
            (filtered.status as string) === 'HIDDEN'
              ? 'HIDDEN'
              : isOnline
                ? 'ONLINE'
                : 'OFFLINE';
          this.realtime.toUser(userId, 'user_status_changed', {
            userId: peer.id,
            status: finalStatus,
            lastSeenAt: filtered.lastSeenAt,
          });
        }
      }
    }

    // 2. Okundu bilgisi gizliliği değiştiğinde
    if (dto.readReceipts !== undefined) {
      const directMemberships = await this.prisma.roomMember.findMany({
        where: { userId, room: { type: RoomType.DIRECT } },
        include: {
          room: {
            include: {
              members: {
                select: { userId: true, lastReadAt: true },
              },
            },
          },
        },
      });

      for (const m of directMemberships) {
        const peer = m.room.members.find((x) => x.userId !== userId);
        if (!peer) continue;
        const peerSettings = await this.privacy.getSettings(peer.userId);

        if (dto.readReceipts) {
          // Okundu bilgisi açıldı: Karşı tarafın da okundu bilgisi açıksa karşılıklı readAt ilet
          if (peerSettings.readReceipts) {
            if (peer.lastReadAt) {
              this.realtime.toUser(userId, 'messages_read', {
                roomId: m.roomId,
                userId: peer.userId,
                readAt: peer.lastReadAt,
              });
            }
            if (m.lastReadAt) {
              this.realtime.toUser(peer.userId, 'messages_read', {
                roomId: m.roomId,
                userId,
                readAt: m.lastReadAt,
              });
            }
          }
        } else {
          // Okundu bilgisi kapatıldı: Karşı tarafa ve bana okundu bilgisinin sıfırlandığını bildir
          this.realtime.toUser(peer.userId, 'messages_read', {
            roomId: m.roomId,
            userId,
            readAt: null,
          });
          this.realtime.toUser(userId, 'messages_read', {
            roomId: m.roomId,
            userId: peer.userId,
            readAt: null,
          });
        }
      }
    }

    // Kullanıcının diğer cihazları da senkron olsun
    this.realtime.toUser(userId, 'settings_updated', settings);
    return settings;
  }

  async getUserProfile(viewerId: string, targetId: string) {
    const user = await this.privacy.getPublicUser(viewerId, targetId);
    if (!user) throw new NotFoundException('Kullanıcı bulunamadı');

    const [contact, dm, commonRooms] = await Promise.all([
      this.prisma.contact.findUnique({
        where: { ownerId_contactId: { ownerId: viewerId, contactId: targetId } },
      }),
      this.prisma.room.findUnique({
        where: { dmKey: makeDmKey(viewerId, targetId) },
        select: {
          id: true,
          members: { where: { userId: viewerId }, select: { mutedUntil: true } },
        },
      }),
      this.prisma.room.findMany({
        where: {
          type: 'ROOM',
          AND: [
            { members: { some: { userId: viewerId } } },
            { members: { some: { userId: targetId } } },
          ],
        },
        select: { id: true, name: true, iconUrl: true },
        take: 20,
      }),
    ]);

    const canCall = await this.privacy.can(viewerId, targetId, 'callVisibility');
    const mutedUntil = dm?.members[0]?.mutedUntil;

    return {
      ...user,
      isContact: !!contact,
      contactNickname: contact?.nickname ?? null,
      directRoomId: dm?.id ?? null,
      isMuted: !!mutedUntil && mutedUntil > new Date(),
      canCall,
      commonRooms,
    };
  }

  async searchUsers(viewerId: string, query: string) {
    const q = (query || '').trim().replace(/^@/, '');
    const users = await this.prisma.user.findMany({
      where: {
        id: { not: viewerId },
        ...(q
          ? {
              OR: [
                { username: { contains: q, mode: 'insensitive' } },
                { displayName: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      take: 30,
      orderBy: { displayName: 'asc' },
      select: publicUserSelect,
    });
    return this.privacy.filterUsers(viewerId, users);
  }

  /** Profil değişikliğini ilgili kullanıcılara, her biri için gizliliğe göre filtreleyerek yollar */
  private async broadcastProfile(userId: string) {
    const raw = await this.prisma.user.findUnique({
      where: { id: userId },
      select: publicUserSelect,
    });
    if (!raw) return;
    this.realtime.toUser(userId, 'me_updated', await this.getMe(userId));

    const related = await this.privacy.getRelatedUserIds(userId);
    for (const viewerId of related) {
      const filtered = await this.privacy.filterUser(viewerId, raw);
      this.realtime.toUser(viewerId, 'user_updated', filtered);
      this.realtime.toUser(viewerId, 'user_status_changed', {
        userId,
        status: filtered.status,
        lastSeenAt: filtered.lastSeenAt,
      });
    }
  }

  async updatePushToken(userId: string, pushToken?: string | null, platform?: string | null) {
    const cleanToken = pushToken ? pushToken.trim() : null;
    const cleanPlatform = platform ? platform.trim().toLowerCase() : null;
    this.logger.log(
      `[UsersService] updatePushToken çağrıldı -> userId: ${userId}, pushToken: ${cleanToken || 'NULL'}, platform: ${cleanPlatform || 'NULL'}`,
    );
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        pushToken: cleanToken,
        pushPlatform: cleanPlatform,
      },
      select: { id: true, username: true, pushToken: true, pushPlatform: true },
    });
    this.logger.log(
      `[UsersService] pushToken veritabanına yazıldı -> ${updated.username} (${updated.id}) = ${updated.pushToken || 'NULL'} [${updated.pushPlatform || 'NULL'}]`,
    );
    return { id: updated.id, pushToken: updated.pushToken, pushPlatform: updated.pushPlatform };
  }
}
