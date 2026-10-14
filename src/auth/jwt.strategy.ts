import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'super-secret-chrono-jwt-key-2026',
    });
  }

  async validate(payload: { sub: string; email: string; sessionId?: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        status: true,
        activeSessionId: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Kullanıcı bulunamadı');
    }

    // Tek cihaz oturumu kontrolü: Eğer token'da sessionId varsa ve kullanıcının DB'deki
    // aktif oturumu ile eşleşmiyorsa eski cihazın erişimini anında kes
    if (payload.sessionId && user.activeSessionId && payload.sessionId !== user.activeSessionId) {
      throw new UnauthorizedException({
        message: 'Oturumunuz başka bir cihazda açıldığı için sonlandırıldı.',
        code: 'SESSION_EXPIRED',
      });
    }

    return user;
  }
}
