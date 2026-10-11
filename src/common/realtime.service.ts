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
  /** roomId -> Set of userIds currently viewing this room */
  readonly activeRoomUsers = new Map<string, Set<string>>();

  attach(server: Server) {
    this.server = server;
  }

  isOnline(userId: string) {
    return (this.onlineUsers.get(userId)?.size ?? 0) > 0;
  }

  /** Kullanıcı bir odaya aktif olarak girdiğinde kaydet */
  joinRoom(userId: string, roomId: string) {
    let users = this.activeRoomUsers.get(roomId);
    if (!users) {
      users = new Set<string>();
      this.activeRoomUsers.set(roomId, users);
    }
    users.add(userId);
  }

  /** Kullanıcı odadan çıktığında kaldır */
  leaveRoom(userId: string, roomId: string) {
    const users = this.activeRoomUsers.get(roomId);
    if (users) {
      users.delete(userId);
      if (users.size === 0) {
        this.activeRoomUsers.delete(roomId);
      }
    }
  }

  /** Kullanıcının bağlantısı koptuğunda tüm aktif odalardan çıkar */
  removeUserFromAllRooms(userId: string) {
    for (const [roomId, users] of this.activeRoomUsers.entries()) {
      if (users.delete(userId) && users.size === 0) {
        this.activeRoomUsers.delete(roomId);
      }
    }
  }

  /** Kullanıcı şu an bu odada aktif olarak bulunuyor mu? */
  isUserInRoom(userId: string, roomId: string): boolean {
    return this.activeRoomUsers.get(roomId)?.has(userId) ?? false;
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
