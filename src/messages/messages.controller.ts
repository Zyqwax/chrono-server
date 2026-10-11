import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { MessagesService } from './messages.service';
import { EditMessageDto, SendMessageDto } from './dto/message.dto';

@UseGuards(JwtAuthGuard)
@Controller('messages')
export class MessagesController {
  constructor(private messagesService: MessagesService) {}

  @Post('room/:roomId')
  sendMessage(
    @CurrentUser() user: { id: string },
    @Param('roomId') roomId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.messagesService.sendMessage(roomId, user.id, dto);
  }

  @Get('room/:roomId')
  getMessages(
    @CurrentUser() user: { id: string },
    @Param('roomId') roomId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    return this.messagesService.getMessages(
      roomId,
      user.id,
      limit ? parseInt(limit, 10) : 50,
      before,
    );
  }

  @Patch(':id')
  editMessage(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: EditMessageDto,
  ) {
    return this.messagesService.editMessage(id, user.id, dto.content);
  }

  @Delete(':id')
  deleteMessage(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.messagesService.deleteMessage(id, user.id);
  }
}
