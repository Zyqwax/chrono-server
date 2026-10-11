import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LivekitService } from './livekit.service';

@UseGuards(JwtAuthGuard)
@Controller('livekit')
export class LivekitController {
  constructor(private livekitService: LivekitService) {}

  @Get('token/:channelId')
  getToken(
    @CurrentUser() user: { id: string; displayName: string },
    @Param('channelId') channelId: string,
  ) {
    return this.livekitService.generateToken(
      channelId,
      user.id,
      user.displayName,
    );
  }
}
