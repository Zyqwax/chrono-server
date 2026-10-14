import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MessageType, Role, RoomType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../common/realtime.service';
import { messageInclude } from '../common/constants';
import { RoomsService, sanitizeMessage } from '../rooms/rooms.service';
import { PushNotificationService } from '../common/push-notification.service';
import { CloudinaryService } from '../common/cloudinary.service';
import { SendMessageDto } from './dto/message.dto';

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private rooms: RoomsService,
    private pushNotifications: PushNotificationService,
    private cloudinary: CloudinaryService,
  ) {}

  async uploadMedia(userId: string, file: Express.Multer.File) {
    if (!file || !file.buffer) {
      throw new BadRequestException('Dosya verisi bulunamadı');
    }

    const mime = (file.mimetype || '').toLowerCase();
    const originalName = (file.originalname || '').toLowerCase();
    const isImage = mime.startsWith('image/');
    const isAudio =
      mime.startsWith('audio/') ||
      mime.includes('audio') ||
      mime === 'video/mp4' ||
      originalName.endsWith('.m4a') ||
      originalName.endsWith('.aac') ||
      originalName.endsWith('.mp3') ||
      originalName.endsWith('.wav') ||
      originalName.endsWith('.ogg');

    if (!isImage && !isAudio) {
      throw new BadRequestException(
        'Desteklenmeyen dosya türü. Yalnızca görsel ve ses dosyaları yüklenebilir.',
      );
    }

    if (isImage) {
      const res = await this.cloudinary.uploadChatImage(file.buffer);
      return {
        url: res.secure_url,
        type: MessageType.IMAGE,
        width: res.width,
        height: res.height,
        format: res.format,
        bytes: res.bytes,
      };
    } else {
      const res = await this.cloudinary.uploadChatAudio(file.buffer);
      return {
        url: res.secure_url,
        type: MessageType.AUDIO,
        duration: res.duration || null,
        format: res.format,
        bytes: res.bytes,
      };
    }
  }

  async sendMessage(
    roomId: string,
    userId: string,
    dto: SendMessageDto,
    type: MessageType = MessageType.TEXT,
  ) {
    const membership = await this.rooms.requireMembership(userId, roomId);
    const messageType = dto.type || type || MessageType.TEXT;
    const content = (dto.content ?? '').trim();
    const ciphertext = dto.ciphertext?.trim() || null;
    const nonce = dto.nonce?.trim() || null;
    const senderPublicKey = dto.senderPublicKey?.trim() || null;

    if (!content && !ciphertext) {
      throw new BadRequestException('Mesaj boş olamaz');
    }
    if (content.length > 4096 || (ciphertext && ciphertext.length > 65536)) {
      throw new BadRequestException('Mesaj izin verilen sınırı aşıyor');
    }

    if (dto.replyToId) {
      const target = await this.prisma.message.findFirst({
        where: { id: dto.replyToId, roomId, deletedAt: null },
        select: { id: true },
      });
      if (!target) dto.replyToId = undefined;
    }

    const message = await this.prisma.message.create({
      data: {
        roomId,
        senderId: userId,
        content: content || null,
        ciphertext,
        nonce,
        senderPublicKey,
        type: messageType,
        replyToId: dto.replyToId,
      },
      include: messageInclude,
    });

    await this.prisma.$transaction([
      this.prisma.room.update({
        where: { id: roomId },
        data: { lastMessageAt: message.createdAt },
      }),
      // Gönderen kendi mesajını okumuş sayılır
      this.prisma.roomMember.update({
        where: { id: membership.id },
        data: { lastReadAt: message.createdAt, hidden: false },
      }),
    ]);

    // DM'de karşı taraf listeden gizliyse (ilk mesaj / silinmiş sohbet) görünür yap
    if (membership.room.type === RoomType.DIRECT) {
      const hiddenMembers = await this.prisma.roomMember.findMany({
        where: { roomId, hidden: true },
        select: { userId: true },
      });
      if (hiddenMembers.length > 0) {
        await this.prisma.roomMember.updateMany({
          where: { roomId, hidden: true },
          data: { hidden: false },
        });
        await this.rooms.pushRoomToUsers(
          roomId,
          hiddenMembers.map((m) => m.userId),
        );
      }
    }

    const memberIds = await this.rooms.getMemberIds(roomId);
    this.realtime.toUsers(memberIds, 'new_message', message);

    // ------------------------------------------------------------------
    // Koşullu Push Bildirimi Gönderimi
    // Alıcı WebSocket üzerinde ilgili odada aktifse push gönderme;
    // Odada değilse / uygulamadan çıkmışsa push bildirimi gönder!
    // ------------------------------------------------------------------
    const otherMemberIds = memberIds.filter((id) => id !== userId);
    if (otherMemberIds.length > 0) {
      const inactiveUserIds = otherMemberIds.filter(
        (id) => !this.realtime.isUserInRoom(id, roomId),
      );

      this.logger.log(
        `[MessagesService] Mesaj push değerlendirmesi -> Oda: ${roomId}, Diğer üyeler: [${otherMemberIds.join(', ')}], Odada olmayanlar: [${inactiveUserIds.join(', ')}]`,
      );

      if (inactiveUserIds.length > 0) {
        const now = new Date();
        const isDirect = membership.room.type === RoomType.DIRECT;

        void Promise.all([
          // 1. Bu odayı sessize almamış üyeler (mutedUntil null veya süresi geçmiş)
          this.prisma.roomMember.findMany({
            where: {
              roomId,
              userId: { in: inactiveUserIds },
              OR: [{ mutedUntil: null }, { mutedUntil: { lte: now } }],
            },
            select: { userId: true },
          }),
          // 2. Kullanıcıların push token'ları ve bildirim ayarları
          this.prisma.user.findMany({
            where: {
              id: { in: inactiveUserIds },
            },
            select: {
              id: true,
              username: true,
              pushToken: true,
              settings: {
                select: {
                  notifyPrivate: true,
                  notifyRooms: true,
                  messagePreview: true,
                },
              },
            },
          }),
        ])
          .then(([unmutedMembers, targetUsers]) => {
            const unmutedUserIds = new Set(unmutedMembers.map((m) => m.userId));
            const eligibleUsers: Array<{
              id: string;
              username: string;
              pushToken: string;
              preview: boolean;
            }> = [];

            for (const u of targetUsers) {
              if (!u.pushToken) {
                this.logger.warn(
                  `[MessagesService] ⚠️ Bildirim gönderilemeyen (DB'de pushToken'ı NULL olan) kullanıcı: ${u.username} (${u.id})`,
                );
                continue;
              }

              // Oda sessize alınmışsa push gönderme
              if (!unmutedUserIds.has(u.id)) {
                this.logger.log(
                  `[MessagesService] 🔕 Kullanıcı (${u.username}) bu odayı sessize aldığı için push bildirimi gönderilmedi.`,
                );
                continue;
              }

              // Kullanıcı bildirim ayarları kontrolü
              const userSettings = u.settings;
              if (isDirect && userSettings?.notifyPrivate === false) {
                this.logger.log(
                  `[MessagesService] 🔕 Kullanıcı (${u.username}) kişisel sohbet bildirimlerini kapattığı için push bildirimi gönderilmedi.`,
                );
                continue;
              }
              if (!isDirect && userSettings?.notifyRooms === false) {
                this.logger.log(
                  `[MessagesService] 🔕 Kullanıcı (${u.username}) sohbet odası bildirimlerini kapattığı için push bildirimi gönderilmedi.`,
                );
                continue;
              }

              eligibleUsers.push({
                id: u.id,
                username: u.username,
                pushToken: u.pushToken,
                preview: userSettings?.messagePreview ?? true,
              });
            }

            if (eligibleUsers.length > 0) {
              this.logger.log(
                `[MessagesService] 📲 Push bildirimi gönderilecek: ${eligibleUsers.map((u) => `${u.username} -> ${u.pushToken}`).join(', ')}`,
              );
              const senderName =
                message.sender?.displayName ||
                message.sender?.username ||
                'Chrono';

              const defaultBody = ciphertext
                ? (messageType === MessageType.IMAGE
                    ? '📷 🔒 Yeni bir fotoğraf'
                    : messageType === MessageType.AUDIO
                      ? '🎤 🔒 Sesli mesaj'
                      : '🔒 Yeni bir mesaj')
                : (messageType === MessageType.IMAGE
                    ? '📷 Fotoğraf'
                    : messageType === MessageType.AUDIO
                      ? '🎤 Sesli mesaj'
                      : content);

              const pushData = {
                messageId: message.id,
                senderId: userId,
                ciphertext,
                nonce,
                senderPublicKey,
              };

              const withPreview = eligibleUsers.filter((u) => u.preview);
              const withoutPreview = eligibleUsers.filter((u) => !u.preview);

              if (withPreview.length > 0) {
                void this.pushNotifications.sendChatMessagePush({
                  recipients: withPreview.map((u) => ({
                    userId: u.id,
                    pushToken: u.pushToken,
                  })),
                  senderName,
                  body: defaultBody,
                  roomId,
                  data: pushData,
                });
              }

              if (withoutPreview.length > 0) {
                void this.pushNotifications.sendChatMessagePush({
                  recipients: withoutPreview.map((u) => ({
                    userId: u.id,
                    pushToken: u.pushToken,
                  })),
                  senderName,
                  body: 'Yeni bir mesajınız var',
                  roomId,
                  data: pushData,
                });
              }
            } else {
              this.logger.log(
                `[MessagesService] Filtreleme sonrası gönderilecek uygun push alıcısı bulunamadı (odalar sessizde, ayarlar kapalı veya token yok).`,
              );
            }
          })
          .catch((err) => {
            this.logger.error(
              `[MessagesService] Push alıcıları sorgulanırken hata: ${String(err)}`,
            );
          });
      }
    }

    return message;
  }

  async getMessages(
    roomId: string,
    userId: string,
    limit = 50,
    before?: string,
    after?: string,
  ) {
    const membership = await this.rooms.requireMembership(userId, roomId);
    const take = Math.min(Math.max(limit, 1), 100);

    const createdAt: { lt?: Date; gt?: Date } = {};
    if (before) createdAt.lt = new Date(before);
    if (after) {
      const afterDate = new Date(after);
      createdAt.gt =
        membership.clearedAt && membership.clearedAt > afterDate
          ? membership.clearedAt
          : afterDate;
    } else if (membership.clearedAt) {
      createdAt.gt = membership.clearedAt;
    }

    const messages = await this.prisma.message.findMany({
      where: {
        roomId,
        ...(Object.keys(createdAt).length ? { createdAt } : {}),
      },
      take,
      orderBy: { createdAt: after ? 'asc' : 'desc' },
      include: messageInclude,
    });

    const sanitized = messages.map((m) => {
      const sanitizedReplyTo = m.replyTo ? sanitizeMessage(m.replyTo) : null;
      return {
        ...sanitizeMessage(m),
        replyTo: sanitizedReplyTo,
      };
    });

    // after kullanıldığında asc çekip tekrar desc sıralayarak tutarlı dönüş sağla
    return after ? sanitized.reverse() : sanitized;
  }

  async editMessage(messageId: string, userId: string, content: string) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.deletedAt) throw new NotFoundException('Mesaj bulunamadı');
    if (message.senderId !== userId) {
      throw new ForbiddenException('Sadece kendi mesajlarınızı düzenleyebilirsiniz');
    }
    if (message.type !== MessageType.TEXT) {
      throw new BadRequestException('Bu mesaj düzenlenemez');
    }
    const clean = (content ?? '').trim();
    if (!clean) throw new BadRequestException('Mesaj boş olamaz');

    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { content: clean, editedAt: new Date() },
      include: messageInclude,
    });
    const memberIds = await this.rooms.getMemberIds(message.roomId);
    this.realtime.toUsers(memberIds, 'message_updated', updated);
    return updated;
  }

  async deleteMessage(messageId: string, userId: string) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { room: true },
    });
    if (!message || message.deletedAt) throw new NotFoundException('Mesaj bulunamadı');

    if (message.senderId !== userId) {
      const membership = await this.rooms.requireMembership(userId, message.roomId);
      const isRoomAdmin =
        message.room.type === RoomType.ROOM && membership.role === Role.ADMIN;
      if (!isRoomAdmin) {
        throw new ForbiddenException('Bu mesajı silme yetkiniz yok');
      }
    }

    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), content: '' },
      include: messageInclude,
    });
    const memberIds = await this.rooms.getMemberIds(message.roomId);
    this.realtime.toUsers(memberIds, 'message_updated', updated);
    return { success: true };
  }
}
