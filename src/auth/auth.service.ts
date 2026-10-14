import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../common/realtime.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private realtime: RealtimeService,
  ) {}

  async checkUser(identifier: string) {
    const clean = identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: clean.toLowerCase() },
          { username: clean.toLowerCase() },
        ],
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
      },
    });

    if (user) {
      return { exists: true, user };
    }
    return { exists: false };
  }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: dto.email }, { username: dto.username }],
      },
    });

    if (existing) {
      if (existing.email === dto.email) {
        throw new ConflictException('Bu e-posta adresi zaten kullanımda');
      }
      throw new ConflictException('Bu kullanıcı adı zaten alınmış');
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(dto.password, salt);
    const activeSessionId = randomUUID();

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        username: dto.username.toLowerCase(),
        displayName: dto.displayName,
        passwordHash,
        avatarUrl: `https://api.dicebear.com/7.x/bottts/png?seed=${encodeURIComponent(dto.username)}`,
        pushToken: dto.pushToken ? dto.pushToken.trim() : null,
        pushPlatform: dto.platform ? dto.platform.trim().toLowerCase() : null,
        activeSessionId,
        publicKey: dto.publicKey ? dto.publicKey.trim() : null,
        encryptedPrivateKey: dto.encryptedPrivateKey ? dto.encryptedPrivateKey.trim() : null,
        keyBackupSalt: dto.keyBackupSalt ? dto.keyBackupSalt.trim() : null,
        keyBackupNonce: dto.keyBackupNonce ? dto.keyBackupNonce.trim() : null,
      },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        status: true,
        pushToken: true,
        pushPlatform: true,
        publicKey: true,
        encryptedPrivateKey: true,
        keyBackupSalt: true,
        keyBackupNonce: true,
        createdAt: true,
      },
    });

    this.logger.log(
      `[AuthService] Yeni kullanıcı kaydedildi: ${user.username} (${user.id}) -> activeSessionId: ${activeSessionId}`,
    );

    const token = this.generateToken(user.id, user.email, activeSessionId);

    return {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        status: user.status,
        pushToken: user.pushToken,
        publicKey: user.publicKey,
      },
      accessToken: token,
      keyBackup: {
        publicKey: user.publicKey,
        encryptedPrivateKey: user.encryptedPrivateKey,
        keyBackupSalt: user.keyBackupSalt,
        keyBackupNonce: user.keyBackupNonce,
      },
    };
  }

  async login(dto: LoginDto) {
    const identifier = dto.identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { username: identifier.toLowerCase() },
        ],
      },
    });

    if (!user) {
      throw new UnauthorizedException('Geçersiz kullanıcı adı veya şifre');
    }

    const isMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('Geçersiz kullanıcı adı veya şifre');
    }

    const cleanPushToken = dto.pushToken ? dto.pushToken.trim() : null;
    const cleanPlatform = dto.platform ? dto.platform.trim().toLowerCase() : user.pushPlatform;
    const newSessionId = randomUUID();

    // 1. Önceki cihaz oturumunu sonlandır: WebSocket'e 'session_expired' bildir ve bağlantıyı kes
    this.logger.log(
      `[AuthService] Yeni oturum açılıyor. Eski oturum düşürülüyor: ${user.username} (${user.id}) -> yeni sessionId: ${newSessionId}`,
    );
    this.realtime.toUser(user.id, 'session_expired', {
      reason: 'Yeni bir cihazda oturum açıldı. Bu cihazdaki oturum sonlandırıldı.',
    });
    this.realtime.disconnectUser(user.id);

    // 2. Kullanıcının aktif oturumunu ve tek push token bilgisini atomik güncelle
    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        activeSessionId: newSessionId,
        pushToken: cleanPushToken ?? user.pushToken,
        pushPlatform: cleanPlatform,
      },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        status: true,
        pushToken: true,
        publicKey: true,
        encryptedPrivateKey: true,
        keyBackupSalt: true,
        keyBackupNonce: true,
      },
    });

    const token = this.generateToken(updatedUser.id, updatedUser.email, newSessionId);

    return {
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        username: updatedUser.username,
        displayName: updatedUser.displayName,
        avatarUrl: updatedUser.avatarUrl,
        status: updatedUser.status,
        pushToken: updatedUser.pushToken,
        publicKey: updatedUser.publicKey,
      },
      accessToken: token,
      keyBackup: {
        publicKey: updatedUser.publicKey,
        encryptedPrivateKey: updatedUser.encryptedPrivateKey,
        keyBackupSalt: updatedUser.keyBackupSalt,
        keyBackupNonce: updatedUser.keyBackupNonce,
      },
    };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        status: true,
        bio: true,
        publicKey: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Kullanıcı bulunamadı');
    }

    return user;
  }

  private generateToken(userId: string, email: string, sessionId: string) {
    const expiresIn = process.env.JWT_EXPIRES_IN || 'never';
    const signOptions: Record<string, any> = {
      secret: process.env.JWT_SECRET || 'super-secret-chrono-jwt-key-2026',
    };
    if (expiresIn && expiresIn !== 'never' && expiresIn !== 'none') {
      signOptions.expiresIn = expiresIn;
    }
    return this.jwtService.sign(
      { sub: userId, email, sessionId },
      signOptions,
    );
  }
}
