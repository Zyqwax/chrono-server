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
    const validRecipients = recipients.filter((r) =>
      Boolean(r.pushToken && Expo.isExpoPushToken(r.pushToken)),
    );

    if (validRecipients.length === 0) return;

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
        for (const ticket of ticketChunk) {
          if (ticket.status === 'error') {
            this.logger.warn(
              `Push bildirimi gönderilemedi: ${ticket.message} (${ticket.details?.error})`,
            );
          }
        }
      } catch (error) {
        this.logger.error('Expo push bildirimleri gönderilirken hata oluştu:', error);
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
    if (!recipient.pushToken || !Expo.isExpoPushToken(recipient.pushToken)) return;

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
      channelId: 'calls_channel',
    };

    try {
      const tickets = await this.expo.sendPushNotificationsAsync([message]);
      for (const ticket of tickets) {
        if (ticket.status === 'error') {
          this.logger.warn(`Arama push bildirimi gönderilemedi: ${ticket.message}`);
        }
      }
    } catch (error) {
      this.logger.error('Expo arama bildirimi gönderilirken hata:', error);
    }
  }
}
