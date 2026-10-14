import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      useFactory: () => {
        const expiresIn = process.env.JWT_EXPIRES_IN;
        const signOptions: Record<string, any> = {};
        if (expiresIn && expiresIn !== 'never' && expiresIn !== 'none') {
          signOptions.expiresIn = expiresIn;
        }
        return {
          secret: process.env.JWT_SECRET || 'super-secret-chrono-jwt-key-2026',
          ...(signOptions.expiresIn ? { signOptions } : {}),
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
