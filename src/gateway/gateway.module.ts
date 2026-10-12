import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MessagesModule } from '../messages/messages.module';
import { RoomsModule } from '../rooms/rooms.module';
import { ChatGateway } from './chat.gateway';
import { CallsController } from './calls.controller';

@Module({
  imports: [AuthModule, MessagesModule, RoomsModule],
  controllers: [CallsController],
  providers: [ChatGateway],
  exports: [ChatGateway],
})
export class GatewayModule {}
