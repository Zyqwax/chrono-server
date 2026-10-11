import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { RoomsModule } from './rooms/rooms.module';
import { MessagesModule } from './messages/messages.module';
import { LivekitModule } from './livekit/livekit.module';
import { GatewayModule } from './gateway/gateway.module';

import { CommonModule } from './common/common.module';
import { UsersModule } from './users/users.module';
import { ContactsModule } from './contacts/contacts.module';

@Module({
  imports: [
    CommonModule,
    PrismaModule,
    AuthModule,
    UsersModule,
    ContactsModule,
    RoomsModule,
    MessagesModule,
    LivekitModule,
    GatewayModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
