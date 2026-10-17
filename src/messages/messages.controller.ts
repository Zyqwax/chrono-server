import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { MessagesService } from './messages.service';
import { EditMessageDto, ReactMessageDto, SendMessageDto } from './dto/message.dto';

@UseGuards(JwtAuthGuard)
@Controller('messages')
export class MessagesController {
  constructor(private messagesService: MessagesService) {}

  @Post('upload-media')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  uploadMedia(
    @CurrentUser() user: { id: string },
    @UploadedFile() file: Express.Multer.File,
    @Query('type') type?: string,
  ) {
    if (!file) {
      throw new BadRequestException('Dosya seçilmedi');
    }
    return this.messagesService.uploadMedia(user.id, file, type);
  }

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
    @Query('after') after?: string,
  ) {
    return this.messagesService.getMessages(
      roomId,
      user.id,
      limit ? parseInt(limit, 10) : 50,
      before,
      after,
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

  @Post(':id/reactions')
  reactToMessage(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: ReactMessageDto,
  ) {
    return this.messagesService.toggleReaction(id, user.id, dto.emoji);
  }

  @Put(':id/reactions')
  putReactionToMessage(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: ReactMessageDto,
  ) {
    return this.messagesService.toggleReaction(id, user.id, dto.emoji);
  }

  @Delete(':id')
  deleteMessage(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.messagesService.deleteMessage(id, user.id);
  }
}
