import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';

/**
 * Gateway dışındaki servislerin (rooms, users, messages) socket olayı
 * yayınlayabilmesi için ince bir köprü. Gateway başlatıldığında server'ı bağlar.
 */
@Injectable()
export class RealtimeService {
  private server: Server | null = null;
  /** userId -> socketId[] */
  readonly onlineUsers = new Map<string, Set<string>>();

  attach(server: Server) {
    this.server = server;
  }

  isOnline(userId: string) {
    return (this.onlineUsers.get(userId)?.size ?? 0) > 0;
  }

  toUser(userId: string, event: string, payload: unknown) {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }

  toUsers(userIds: string[], event: string, payload: unknown) {
    if (!this.server || userIds.length === 0) return;
    this.server.to(userIds.map((id) => `user:${id}`)).emit(event, payload);
  }

  /** Kullanıcının tüm soketlerini bir socket.io odasına ekler/çıkarır */
  joinUserTo(userId: string, room: string) {
    this.server?.in(`user:${userId}`).socketsJoin(room);
  }

  leaveUserFrom(userId: string, room: string) {
    this.server?.in(`user:${userId}`).socketsLeave(room);
  }
}
