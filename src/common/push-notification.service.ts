import { Injectable, Logger } from '@nestjs/common';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';

export interface PushRecipient {
  userId: string;
  pushToken: string;
}

export interface SendChatMessagePushOptions {
  recipients: PushRecipient[];
  senderName: string;
  body: string;
  roomId: string;
}

export interface SendCallPushOptions {
  recipient: PushRecipient;
  callerName: string;
  roomId: string;
  callId: string;
  isVideo: boolean;
}

@Injectable()
export class PushNotificationService {
  private readonly logger = new Logger(PushNotificationService.name);
  private readonly expo = new Expo();

  /**
   * Sohbet mesajı için Expo Push bildirimi gönderir.
   * WhatsApp standardında:
   * - Yüksek öncelik
   * - Android: chat-messages kanalı ve room_${roomId} collapseId
   * - iOS: room_${roomId} threadId
   */
  async sendChatMessagePush({
    recipients,
    senderName,
    body,
    roomId,
  }: SendChatMessagePushOptions): Promise<void> {
    this.logger.log(
      `[PushNotificationService] sendChatMessagePush -> Gelen alıcı sayısı: ${recipients.length}, Gönderen: "${senderName}", Oda: ${roomId}`,
    );

    const validRecipients = recipients.filter((r) =>
      Boolean(r.pushToken && Expo.isExpoPushToken(r.pushToken)),
    );

    const invalidRecipients = recipients.filter(
      (r) => !r.pushToken || !Expo.isExpoPushToken(r.pushToken),
    );
    if (invalidRecipients.length > 0) {
      this.logger.warn(
        `[PushNotificationService] ⚠️ Geçersiz Expo push token formatına sahip alıcılar filtrelendi: ${JSON.stringify(invalidRecipients)}`,
      );
    }

    if (validRecipients.length === 0) {
      this.logger.warn(`[PushNotificationService] Geçerli Expo pushToken bulunamadı, push iptal edildi.`);
      return;
    }

    this.logger.log(
      `[PushNotificationService] ${validRecipients.length} cihaza Expo Push gönderiliyor: ${validRecipients.map((r) => r.pushToken).join(', ')}`,
    );

    const messages: ExpoPushMessage[] = validRecipients.map((r) => ({
      to: r.pushToken,
      sound: 'default',
      priority: 'high',
      title: senderName,
      body: body || 'Yeni bir mesajınız var',
      data: {
        roomId,
        type: 'message',
      },
      channelId: 'chat-messages',
      collapseId: `room_${roomId}`,
      threadId: `room_${roomId}`,
    }));

    const chunks = this.expo.chunkPushNotifications(messages);

    for (const chunk of chunks) {
      try {
        const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);
        this.logger.log(`[PushNotificationService] Expo API yanıtı: ${JSON.stringify(ticketChunk)}`);
        for (const ticket of ticketChunk) {
          if (ticket.status === 'error') {
            this.logger.warn(
              `[PushNotificationService] ❌ Push ticket hatası: ${ticket.message} (${ticket.details?.error})`,
            );
          }
        }
      } catch (error) {
        this.logger.error('[PushNotificationService] ❌ Expo push bildirimleri gönderilirken HTTP hatası:', error);
      }
    }
  }

  /**
   * Gelen sesli/görüntülü arama için yüksek öncelikli Heads-up çağrı bildirimi gönderir.
   */
  async sendIncomingCallPush({
    recipient,
    callerName,
    roomId,
    callId,
    isVideo,
  }: SendCallPushOptions): Promise<void> {
    this.logger.log(
      `[PushNotificationService] sendIncomingCallPush çağrıldı -> Arayan: "${callerName}", Alıcı userId: ${recipient.userId}, token: ${recipient.pushToken || 'NULL'}`,
    );

    if (!recipient.pushToken || !Expo.isExpoPushToken(recipient.pushToken)) {
      this.logger.warn(
        `[PushNotificationService] Gelen arama push bildirimi gönderilemedi: Token eksik veya geçersiz (${recipient.pushToken})`,
      );
      return;
    }

    const message: ExpoPushMessage = {
      to: recipient.pushToken,
      sound: 'default',
      priority: 'high',
      title: callerName,
      body: isVideo ? '📹 Gelen görüntülü arama...' : '📞 Gelen sesli arama...',
      data: {
        type: 'incoming_call',
        roomId,
        callId,
        video: isVideo,
        callerName,
      },
      channelId: 'calls_channel_v2',
    };

    try {
      const tickets = await this.expo.sendPushNotificationsAsync([message]);
      this.logger.log(`[PushNotificationService] Arama push yanıtı: ${JSON.stringify(tickets)}`);
      for (const ticket of tickets) {
        if (ticket.status === 'error') {
          this.logger.warn(`[PushNotificationService] ❌ Arama push bildirimi hatası: ${ticket.message}`);
        }
      }
    } catch (error) {
      this.logger.error('[PushNotificationService] ❌ Expo arama bildirimi gönderilirken hata:', error);
    }
  }
}
