import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { ChatGateway } from './chat.gateway';

interface AuthUser {
  id: string;
  email: string;
}

class DeclineCallDto {
  callId?: string;
}

@Controller('calls')
@UseGuards(JwtAuthGuard)
export class CallsController {
  private readonly logger = new Logger(CallsController.name);

  constructor(private readonly chatGateway: ChatGateway) {}

  @Post(':callId/decline')
  @HttpCode(HttpStatus.OK)
  async declineCallParam(
    @CurrentUser() user: AuthUser,
    @Param('callId') callId: string,
  ) {
    this.logger.log(`[CallsController] POST /calls/${callId}/decline -> userId: ${user.id}`);
    const ok = await this.chatGateway.declineCall(user.id, callId);
    return { ok };
  }

  @Post('decline')
  @HttpCode(HttpStatus.OK)
  async declineCallBody(
    @CurrentUser() user: AuthUser,
    @Body() dto: DeclineCallDto,
  ) {
    const callId = dto?.callId;
    this.logger.log(`[CallsController] POST /calls/decline -> userId: ${user.id}, callId: ${callId}`);
    if (!callId) return { ok: false };
    const ok = await this.chatGateway.declineCall(user.id, callId);
    return { ok };
  }
}
