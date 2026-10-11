import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MessageType, Role, RoomType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../common/realtime.service';
import { messageInclude } from '../common/constants';
import { RoomsService, sanitizeMessage } from '../rooms/rooms.service';
import { PushNotificationService } from '../common/push-notification.service';
import { SendMessageDto } from './dto/message.dto';

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private rooms: RoomsService,
    private pushNotifications: PushNotificationService,
  ) {}

  async sendMessage(
    roomId: string,
    userId: string,
    dto: SendMessageDto,
    type: MessageType = MessageType.TEXT,
  ) {
    const membership = await this.rooms.requireMembership(userId, roomId);
    const content = (dto.content ?? '').trim();
    if (!content) throw new BadRequestException('Mesaj boş olamaz');
    if (content.length > 4096) {
      throw new BadRequestException('Mesaj en fazla 4096 karakter olabilir');
    }

    if (dto.replyToId) {
      const target = await this.prisma.message.findFirst({
        where: { id: dto.replyToId, roomId },
        select: { id: true },
      });
      if (!target) dto.replyToId = undefined;
    }

    const message = await this.prisma.message.create({
      data: {
        roomId,
        senderId: userId,
        content,
        type,
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

      if (inactiveUserIds.length > 0) {
        void this.prisma.user
          .findMany({
            where: {
              id: { in: inactiveUserIds },
              pushToken: { not: null },
            },
            select: { id: true, pushToken: true },
          })
          .then((targetUsers) => {
            const recipients = targetUsers
              .filter((u): u is { id: string; pushToken: string } => Boolean(u.pushToken))
              .map((u) => ({ userId: u.id, pushToken: u.pushToken }));

            if (recipients.length > 0) {
              const senderName =
                message.sender?.displayName ||
                message.sender?.username ||
                'Chrono';

              const pushBody =
                type === MessageType.IMAGE
                  ? '📷 Fotoğraf'
                  : content;

              void this.pushNotifications.sendChatMessagePush({
                recipients,
                senderName,
                body: pushBody,
                roomId,
              });
            }
          })
          .catch(() => {});
      }
    }

    return message;
  }

  async getMessages(roomId: string, userId: string, limit = 50, before?: string) {
    const membership = await this.rooms.requireMembership(userId, roomId);
    const take = Math.min(Math.max(limit, 1), 100);

    const createdAt: { lt?: Date; gt?: Date } = {};
    if (before) createdAt.lt = new Date(before);
    if (membership.clearedAt) createdAt.gt = membership.clearedAt;

    const messages = await this.prisma.message.findMany({
      where: {
        roomId,
        ...(Object.keys(createdAt).length ? { createdAt } : {}),
      },
      take,
      orderBy: { createdAt: 'desc' },
      include: messageInclude,
    });

    return messages.map((m) =>
      sanitizeMessage({
        ...m,
        replyTo: m.replyTo ? sanitizeMessage(m.replyTo) : null,
      }),
    );
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
