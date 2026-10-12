import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
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

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        username: dto.username.toLowerCase(),
        displayName: dto.displayName,
        passwordHash,
        avatarUrl: `https://api.dicebear.com/7.x/bottts/png?seed=${encodeURIComponent(dto.username)}`,
        pushToken: dto.pushToken ? dto.pushToken.trim() : null,
        pushPlatform: dto.platform ? dto.platform.trim().toLowerCase() : null,
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
        createdAt: true,
      },
    });

    this.logger.log(
      `[AuthService] Yeni kullanıcı kaydedildi: ${user.username} (${user.id}) -> pushToken: ${user.pushToken || 'NULL'}, platform: ${user.pushPlatform || 'NULL'}`,
    );

    const token = this.generateToken(user.id, user.email);

    return {
      user,
      accessToken: token,
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

    let currentPushToken = user.pushToken;
    this.logger.log(
      `[AuthService] Kullanıcı giriş yaptı: ${user.username} (${user.id}) -> İstekten gelen pushToken: ${dto.pushToken ? dto.pushToken.trim() : 'YOK'}, DB'deki token: ${user.pushToken || 'YOK'}`,
    );

    if (dto.pushToken && (dto.pushToken.trim() !== user.pushToken || dto.platform)) {
      const cleanToken = dto.pushToken.trim();
      const cleanPlatform = dto.platform ? dto.platform.trim().toLowerCase() : user.pushPlatform;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          pushToken: cleanToken,
          pushPlatform: cleanPlatform,
        },
      });
      currentPushToken = cleanToken;
      this.logger.log(
        `[AuthService] Kullanıcı ${user.username} için pushToken güncellendi: ${currentPushToken} [${cleanPlatform || 'NULL'}]`,
      );
    }

    const token = this.generateToken(user.id, user.email);

    return {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        status: user.status,
        pushToken: currentPushToken,
      },
      accessToken: token,
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
        createdAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Kullanıcı bulunamadı');
    }

    return user;
  }

  private generateToken(userId: string, email: string) {
    return this.jwtService.sign(
      { sub: userId, email },
      {
        secret: process.env.JWT_SECRET || 'super-secret-chrono-jwt-key-2026',
        expiresIn: '7d',
      },
    );
  }
}
