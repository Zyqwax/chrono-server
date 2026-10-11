import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { MessageType, RoomType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MessagesService } from '../messages/messages.service';
import { RoomsService } from '../rooms/rooms.service';
import { RealtimeService } from '../common/realtime.service';
import { PrivacyService } from '../common/privacy.service';
import { JWT_SECRET, senderSelect } from '../common/constants';
import { PushNotificationService } from '../common/push-notification.service';

type CallState = {
  callId: string;
  roomId: string;
  callerId: string;
  calleeId: string;
  video: boolean;
  state: 'ringing' | 'active';
  startedAt: number;
  acceptedAt?: number;
  timeout?: NodeJS.Timeout;
};

const RING_TIMEOUT_MS = 35_000;

@WebSocketGateway({ cors: { origin: '*' } })
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server: Server;

  /** roomId -> katılımcı userId seti (sohbet odası sesli sohbeti) */
  private activeVoiceRooms = new Map<string, Set<string>>();
  /** roomId -> sesli sohbet oturum bilgisi (başlangıç saati ve katılan herkes) */
  private voiceRoomSessions = new Map<string, { startedAt: number; allParticipants: Set<string> }>();
  /** callId -> çağrı durumu (DM arama) */
  private calls = new Map<string, CallState>();
  /** userId -> aktif arama arkaplan kopma mola zamanlayıcısı */
  private callDisconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private jwtService: JwtService,
    private prisma: PrismaService,
    private messagesService: MessagesService,
    private roomsService: RoomsService,
    private realtime: RealtimeService,
    private privacy: PrivacyService,
    private pushNotifications: PushNotificationService,
  ) {}

  afterInit(server: Server) {
    this.realtime.attach(server);
  }

  // ------------------------------------------------------------------
  // Bağlantı & çevrimiçi durumu
  // ------------------------------------------------------------------

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');
      if (!token) return client.disconnect();

      const payload = this.jwtService.verify(token, { secret: JWT_SECRET });
      const userId: string = payload.sub;
      client.data.userId = userId;

      const exists = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!exists) return client.disconnect();

      await client.join(`user:${userId}`);

      const sockets = this.realtime.onlineUsers.get(userId) ?? new Set<string>();
      const wasOffline = sockets.size === 0;
      sockets.add(client.id);
      this.realtime.onlineUsers.set(userId, sockets);

      // Kullanıcı tekrar bağlandıysa bekleyen arama kopma zamanlayıcısını iptal et
      const pendingTimer = this.callDisconnectTimers.get(userId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.callDisconnectTimers.delete(userId);
        this.logger.log(`Kullanıcı (${userId}) yeniden bağlandı; arama düşme süresi iptal edildi.`);
      }

      if (wasOffline) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { status: 'ONLINE' },
        });
        await this.broadcastPresence(userId, 'ONLINE', null);
      }

      // Devam eden gelen arama varsa yeni cihaza da bildir
      for (const call of this.calls.values()) {
        if (call.calleeId === userId && call.state === 'ringing') {
          client.emit('call_incoming', await this.callPayload(call));
        }
      }

      // Aktif odalardaki sesli sohbet durumlarını bildir
      for (const [rId, participants] of this.activeVoiceRooms.entries()) {
        if (participants.size > 0) {
          client.emit('voice_state_updated', {
            roomId: rId,
            participants: Array.from(participants),
            participantsCount: participants.size,
          });
        }
      }
    } catch {
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    const userId: string | undefined = client.data?.userId;
    if (!userId) return;

    const sockets = this.realtime.onlineUsers.get(userId);
    sockets?.delete(client.id);
    if (sockets && sockets.size > 0) return;

    this.realtime.onlineUsers.delete(userId);
    this.realtime.removeUserFromAllRooms(userId);
    const lastSeenAt = new Date();
    await this.prisma.user
      .update({ where: { id: userId }, data: { status: 'OFFLINE', lastSeenAt } })
      .catch(() => undefined);
    await this.broadcastPresence(userId, 'OFFLINE', lastSeenAt);

    // Sesli sohbetlerden çıkar
    for (const [roomId, participants] of this.activeVoiceRooms.entries()) {
      if (participants.delete(userId)) {
        if (participants.size === 0) {
          this.activeVoiceRooms.delete(roomId);
          const session = this.voiceRoomSessions.get(roomId);
          this.voiceRoomSessions.delete(roomId);
          if (session) {
            const duration = Math.max(1, Math.round((Date.now() - session.startedAt) / 1000));
            void this.logVoiceRoomEnd(roomId, session.allParticipants.size, duration);
          }
        }
        void this.emitVoiceState(roomId, { userLeftId: userId });
      }
    }

    // Devam eden aramaları bitir veya aktif görüşmeler için mola tanı
    for (const call of [...this.calls.values()]) {
      if (call.callerId === userId || call.calleeId === userId) {
        if (call.state === 'active') {
          // Aktif görüşmedeyken kullanıcı arkaplana geçerse arama hemen düşmesin!
          // 25 saniyelik mola tanı, kullanıcı bağlanırsa arama devam eder.
          if (!this.callDisconnectTimers.has(userId)) {
            const timeout = setTimeout(async () => {
              this.callDisconnectTimers.delete(userId);
              const stillCall = this.calls.get(call.callId);
              if (stillCall) {
                await this.finishCall(stillCall, 'ended');
              }
            }, 25_000);
            this.callDisconnectTimers.set(userId, timeout);
          }
        } else {
          // Henüz açılmamış çalan aramayı sonlandır
          await this.finishCall(call, 'missed');
        }
      }
    }
  }

  /** Durumu, gizlilik ayarına ve karşılıklılık ilkesine uyarak ilgili kullanıcılara yayınla */
  private async broadcastPresence(
    userId: string,
    status: 'ONLINE' | 'OFFLINE',
    lastSeenAt: Date | null,
  ) {
    const related = await this.privacy.getRelatedUserIds(userId);
    if (related.length === 0) return;

    const [userSettings, relatedSettings, contacts] = await Promise.all([
      this.privacy.getSettings(userId),
      this.prisma.userSettings.findMany({
        where: { userId: { in: related } },
      }),
      this.prisma.contact.findMany({
        where: {
          OR: [
            { ownerId: userId, contactId: { in: related } },
            { ownerId: { in: related }, contactId: userId },
          ],
        },
      }),
    ]);

    const settingsMap = new Map(relatedSettings.map((s) => [s.userId, s]));
    const isContactOfUser = new Set(
      contacts.filter((c) => c.ownerId === userId).map((c) => c.contactId),
    );
    const isContactOfViewer = new Set(
      contacts.filter((c) => c.contactId === userId).map((c) => c.ownerId),
    );

    for (const viewerId of related) {
      const viewerSettings = settingsMap.get(viewerId);
      const isViewerInUserContacts = isContactOfUser.has(viewerId);
      const isUserInViewerContacts = isContactOfViewer.has(viewerId);

      // 1. Kullanıcı viewer'a izin veriyor mu?
      const userAllows = this.privacy.allowed(
        userSettings.lastSeenVisibility,
        isViewerInUserContacts,
        false,
      );

      // 2. Viewer kendi çevrimiçi durumunu paylaşıyor mu (mütekabiliyet)?
      const viewerAllows = viewerSettings
        ? this.privacy.allowed(viewerSettings.lastSeenVisibility, isUserInViewerContacts, false)
        : true;

      const canSee = userAllows && viewerAllows;

      if (canSee) {
        this.realtime.toUser(viewerId, 'user_status_changed', {
          userId,
          status,
          lastSeenAt,
        });
      } else {
        // Çevrimiçi durumunu gizleyen kullanıcı diğerleri için HIDDEN görünür
        this.realtime.toUser(viewerId, 'user_status_changed', {
          userId,
          status: 'HIDDEN',
          lastSeenAt: null,
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // Mesajlaşma
  // ------------------------------------------------------------------

  @SubscribeMessage('join_room')
  async handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const userId = client.data?.userId;
    if (!userId || !data?.roomId) return;
    try {
      await this.roomsService.requireMembership(userId, data.roomId);
    } catch {
      return { status: 'forbidden' };
    }
    await client.join(`room:${data.roomId}`);
    this.realtime.joinRoom(userId, data.roomId);
    client.emit('voice_state_updated', {
      roomId: data.roomId,
      participants: Array.from(this.activeVoiceRooms.get(data.roomId) ?? []),
    });
    return { status: 'joined', roomId: data.roomId };
  }

  @SubscribeMessage('leave_room')
  async handleLeaveRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const userId = client.data?.userId;
    if (userId && data?.roomId) {
      this.realtime.leaveRoom(userId, data.roomId);
    }
    await client.leave(`room:${data.roomId}`);
    return { status: 'left', roomId: data.roomId };
  }

  @SubscribeMessage('send_message')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; content: string; replyToId?: string; tempId?: string },
  ) {
    const userId = client.data?.userId;
    if (!userId) return { ok: false };
    try {
      const message = await this.messagesService.sendMessage(data.roomId, userId, {
        content: data.content,
        replyToId: data.replyToId,
      });
      return { ok: true, message, tempId: data.tempId };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Mesaj gönderilemedi', tempId: data.tempId };
    }
  }

  /** Geriye dönük uyumluluk */
  @SubscribeMessage('send_room_message')
  handleSendRoomMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; content: string },
  ) {
    return this.handleSendMessage(client, data);
  }

  @SubscribeMessage('mark_read')
  async handleMarkRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const userId = client.data?.userId;
    if (!userId) return;
    try {
      return await this.roomsService.markRead(userId, data.roomId);
    } catch {
      return { success: false };
    }
  }

  @SubscribeMessage('typing')
  async handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; isTyping: boolean },
  ) {
    const userId = client.data?.userId;
    if (!userId || !data?.roomId) return;
    const memberIds = await this.roomsService.getMemberIds(data.roomId);
    if (!memberIds.includes(userId)) return;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true },
    });
    this.realtime.toUsers(
      memberIds.filter((id) => id !== userId),
      'user_typing',
      {
        roomId: data.roomId,
        userId,
        displayName: user?.displayName ?? '',
        isTyping: !!data.isTyping,
      },
    );
  }

  /** Geriye dönük uyumluluk */
  @SubscribeMessage('room_typing')
  handleRoomTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; isTyping: boolean },
  ) {
    return this.handleTyping(client, data);
  }

  // ------------------------------------------------------------------
  // Sohbet odası sesli sohbeti (Telegram "Görüntülü Sohbet" benzeri)
  // ------------------------------------------------------------------

  private async emitVoiceState(roomId: string, extra: Record<string, unknown> = {}) {
    const participantIds = Array.from(this.activeVoiceRooms.get(roomId) ?? []);
    const memberIds = await this.roomsService.getMemberIds(roomId);
    const participantUsers = participantIds.length > 0
      ? await this.prisma.user.findMany({
          where: { id: { in: participantIds } },
          select: senderSelect,
        })
      : [];

    this.realtime.toUsers(memberIds, 'voice_state_updated', {
      roomId,
      participants: participantIds,
      participantsCount: participantIds.length,
      participantUsers,
      ...extra,
    });
  }

  @SubscribeMessage('join_room_voice')
  async handleJoinRoomVoice(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const userId = client.data?.userId;
    if (!userId) return;
    try {
      const m = await this.roomsService.requireMembership(userId, data.roomId);
      if (m.room.type !== RoomType.ROOM) return { status: 'invalid' };
    } catch {
      return { status: 'forbidden' };
    }

    const participants = this.activeVoiceRooms.get(data.roomId) ?? new Set<string>();
    participants.add(userId);
    this.activeVoiceRooms.set(data.roomId, participants);

    // Sesli sohbet oturumunu başlat veya katılımcıyı ekle
    const existingSession = this.voiceRoomSessions.get(data.roomId);
    if (!existingSession) {
      this.voiceRoomSessions.set(data.roomId, {
        startedAt: Date.now(),
        allParticipants: new Set([userId]),
      });
    } else {
      existingSession.allParticipants.add(userId);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: senderSelect,
    });
    await this.emitVoiceState(data.roomId, { userJoined: user });

    const participantIds = Array.from(this.activeVoiceRooms.get(data.roomId) ?? []);
    const participantUsers = await this.prisma.user.findMany({
      where: { id: { in: participantIds } },
      select: senderSelect,
    });

    return {
      status: 'joined_voice',
      roomId: data.roomId,
      mediaRoom: `voice-${data.roomId}`,
      participantUsers,
    };
  }

  @SubscribeMessage('leave_room_voice')
  async handleLeaveRoomVoice(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const userId = client.data?.userId;
    if (!userId) return;
    const participants = this.activeVoiceRooms.get(data.roomId);
    if (participants?.delete(userId)) {
      if (participants.size === 0) {
        this.activeVoiceRooms.delete(data.roomId);
        const session = this.voiceRoomSessions.get(data.roomId);
        this.voiceRoomSessions.delete(data.roomId);
        if (session) {
          const duration = Math.max(1, Math.round((Date.now() - session.startedAt) / 1000));
          await this.logVoiceRoomEnd(data.roomId, session.allParticipants.size, duration);
        }
      }
      await this.emitVoiceState(data.roomId, { userLeftId: userId });
    }
    return { status: 'left_voice', roomId: data.roomId };
  }

  // ------------------------------------------------------------------
  // DM sesli / görüntülü arama sinyalleşmesi
  // ------------------------------------------------------------------

  private isBusy(userId: string) {
    for (const c of this.calls.values()) {
      if (c.callerId === userId || c.calleeId === userId) return true;
    }
    return false;
  }

  private async callPayload(call: CallState) {
    const [caller, callee] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: call.callerId }, select: senderSelect }),
      this.prisma.user.findUnique({ where: { id: call.calleeId }, select: senderSelect }),
    ]);
    return {
      callId: call.callId,
      roomId: call.roomId,
      video: call.video,
      state: call.state,
      caller,
      callee,
      startedAt: call.startedAt,
      acceptedAt: call.acceptedAt ?? null,
      /** LiveKit oda adı (medya katmanı için) */
      mediaRoom: `call_${call.callId}`,
    };
  }

  @SubscribeMessage('call_start')
  async handleCallStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; video?: boolean },
  ) {
    const userId = client.data?.userId;
    if (!userId) return { ok: false };

    let membership;
    try {
      membership = await this.roomsService.requireMembership(userId, data.roomId);
    } catch {
      return { ok: false, error: 'Bu sohbete erişiminiz yok' };
    }
    if (membership.room.type !== RoomType.DIRECT) {
      return { ok: false, error: 'Arama yalnızca birebir sohbetlerde yapılabilir' };
    }

    const memberIds = await this.roomsService.getMemberIds(data.roomId);
    const calleeId = memberIds.find((id) => id !== userId);
    if (!calleeId) return { ok: false, error: 'Kullanıcı bulunamadı' };

    if (!(await this.privacy.can(userId, calleeId, 'callVisibility'))) {
      return { ok: false, error: 'Bu kullanıcı gizlilik ayarları nedeniyle aranamıyor' };
    }
    if (this.isBusy(userId)) return { ok: false, error: 'Zaten bir aramadasınız' };
    if (this.isBusy(calleeId)) {
      await this.logCall(data.roomId, userId, !!data.video, 'busy', 0);
      return { ok: false, error: 'Kullanıcı şu anda başka bir aramada' };
    }

    const call: CallState = {
      callId: randomUUID(),
      roomId: data.roomId,
      callerId: userId,
      calleeId,
      video: !!data.video,
      state: 'ringing',
      startedAt: Date.now(),
    };
    call.timeout = setTimeout(() => {
      void this.finishCall(call, 'missed');
    }, RING_TIMEOUT_MS);
    this.calls.set(call.callId, call);

    const payload = await this.callPayload(call);
    this.realtime.toUser(calleeId, 'call_incoming', payload);
    // Arayanın diğer cihazları da arama ekranını görsün
    this.realtime.toUser(userId, 'call_outgoing', payload);

    // Aranan kullanıcı sokette değilse veya arka plandaysa acil çağrı push bildirimi gönder
    void this.prisma.user
      .findUnique({
        where: { id: calleeId },
        select: { pushToken: true },
      })
      .then((calleeUser) => {
        if (calleeUser?.pushToken) {
          const callerName =
            payload.caller?.displayName ||
            payload.caller?.username ||
            'Chrono';
          void this.pushNotifications.sendIncomingCallPush({
            recipient: { userId: calleeId, pushToken: calleeUser.pushToken },
            callerName,
            roomId: data.roomId,
            callId: call.callId,
            isVideo: !!data.video,
          });
        }
      })
      .catch(() => {});

    return {
      ok: true,
      call: payload,
      calleeOnline: this.realtime.isOnline(calleeId),
    };
  }

  @SubscribeMessage('call_accept')
  async handleCallAccept(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string },
  ) {
    const userId = client.data?.userId;
    const call = this.calls.get(data?.callId);
    if (!call || call.calleeId !== userId || call.state !== 'ringing') {
      return { ok: false };
    }
    if (call.timeout) clearTimeout(call.timeout);
    call.state = 'active';
    call.acceptedAt = Date.now();

    const payload = await this.callPayload(call);
    this.realtime.toUsers([call.callerId, call.calleeId], 'call_accepted', {
      ...payload,
      acceptedBySocket: client.id,
    });
    return { ok: true, call: payload };
  }

  @SubscribeMessage('call_decline')
  async handleCallDecline(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string },
  ) {
    const userId = client.data?.userId;
    const call = this.calls.get(data?.callId);
    if (!call || (call.calleeId !== userId && call.callerId !== userId)) return { ok: false };
    const reason =
      call.state === 'active'
        ? 'ended'
        : call.callerId === userId
          ? 'cancelled'
          : 'declined';
    await this.finishCall(call, reason);
    return { ok: true };
  }

  @SubscribeMessage('call_end')
  async handleCallEnd(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string },
  ) {
    return this.handleCallDecline(client, data);
  }

  /** Mikrofon / kamera durumunu karşı tarafa ilet */
  @SubscribeMessage('call_media_state')
  handleCallMediaState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callId: string; muted?: boolean; videoOn?: boolean },
  ) {
    const userId = client.data?.userId;
    const call = this.calls.get(data?.callId);
    if (!call || (call.calleeId !== userId && call.callerId !== userId)) return;
    const other = call.callerId === userId ? call.calleeId : call.callerId;
    this.realtime.toUser(other, 'call_media_state', {
      callId: call.callId,
      userId,
      muted: data.muted,
      videoOn: data.videoOn,
    });
  }

  private async finishCall(
    call: CallState,
    reason: 'ended' | 'declined' | 'missed' | 'cancelled',
  ) {
    if (!this.calls.has(call.callId)) return;
    this.calls.delete(call.callId);
    if (call.timeout) clearTimeout(call.timeout);

    const callerTimer = this.callDisconnectTimers.get(call.callerId);
    if (callerTimer) {
      clearTimeout(callerTimer);
      this.callDisconnectTimers.delete(call.callerId);
    }
    const calleeTimer = this.callDisconnectTimers.get(call.calleeId);
    if (calleeTimer) {
      clearTimeout(calleeTimer);
      this.callDisconnectTimers.delete(call.calleeId);
    }

    const duration = call.acceptedAt
      ? Math.round((Date.now() - call.acceptedAt) / 1000)
      : 0;

    this.realtime.toUsers([call.callerId, call.calleeId], 'call_ended', {
      callId: call.callId,
      roomId: call.roomId,
      reason,
      duration,
    });

    await this.logCall(call.roomId, call.callerId, call.video, reason, duration);
  }

  /** Aramayı sohbet geçmişine "CALL" türünde mesaj olarak yaz */
  private async logCall(
    roomId: string,
    callerId: string,
    video: boolean,
    status: string,
    duration: number,
  ) {
    try {
      await this.messagesService.sendMessage(
        roomId,
        callerId,
        { content: JSON.stringify({ video, status, duration }) },
        MessageType.CALL,
      );
    } catch (err) {
      this.logger.warn(`Arama kaydı yazılamadı: ${String(err)}`);
    }
  }

  private formatDurationText(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const remainingSecs = seconds % 60;
    if (mins > 0 && remainingSecs > 0) {
      return `${mins} dakika ${remainingSecs} saniye`;
    } else if (mins > 0) {
      return `${mins} dakika`;
    }
    return `${remainingSecs} saniye`;
  }

  /** Odada sesli sohbet sona erdiğinde sistem mesajı olarak kaydet ve yayınla */
  private async logVoiceRoomEnd(
    roomId: string,
    participantsCount: number,
    durationSeconds: number,
  ) {
    try {
      const memberIds = await this.roomsService.getMemberIds(roomId);
      if (memberIds.length === 0) return;
      const senderId = memberIds[0];

      const durationText = this.formatDurationText(durationSeconds);
      const content = `🎙️ Sesli sohbet sona erdi · ${participantsCount} kişi katıldı (${durationText})`;

      await this.messagesService.sendMessage(
        roomId,
        senderId,
        { content },
        MessageType.SYSTEM,
      );
    } catch (err) {
      this.logger.warn(`Sesli sohbet bitiş mesajı yazılamadı: ${String(err)}`);
    }
  }
}
