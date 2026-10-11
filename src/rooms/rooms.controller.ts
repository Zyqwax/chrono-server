import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RoomsService } from './rooms.service';
import {
  AddMemberDto,
  CreateRoomDto,
  OpenDirectDto,
  SetRoleDto,
  UpdateMembershipDto,
  UpdateRoomDto,
} from './dto/rooms.dto';

type AuthUser = { id: string };

@Controller('rooms')
@UseGuards(JwtAuthGuard)
export class RoomsController {
  constructor(private roomsService: RoomsService) {}

  @Post('upload-icon')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 8 * 1024 * 1024 },
    }),
  )
  uploadTempIcon(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.roomsService.uploadTempIcon(user.id, file);
  }

  @Post(':id/icon')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 8 * 1024 * 1024 },
    }),
  )
  uploadRoomIcon(
    @CurrentUser() user: AuthUser,
    @Param('id') roomId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.roomsService.uploadRoomIcon(user.id, roomId, file);
  }

  @Delete(':id/icon')
  removeRoomIcon(
    @CurrentUser() user: AuthUser,
    @Param('id') roomId: string,
  ) {
    return this.roomsService.removeRoomIcon(user.id, roomId);
  }

  @Post()
  createRoom(@CurrentUser() user: AuthUser, @Body() dto: CreateRoomDto) {
    return this.roomsService.createRoom(user.id, dto);
  }

  @Post('direct')
  openDirect(@CurrentUser() user: AuthUser, @Body() dto: OpenDirectDto) {
    return this.roomsService.openDirect(user.id, dto.userId);
  }

  @Get()
  getUserRooms(@CurrentUser() user: AuthUser) {
    return this.roomsService.getUserRooms(user.id);
  }

  @Get(':id')
  getRoomDetails(@CurrentUser() user: AuthUser, @Param('id') roomId: string) {
    return this.roomsService.getRoomDetails(user.id, roomId);
  }

  @Patch(':id')
  updateRoom(
    @CurrentUser() user: AuthUser,
    @Param('id') roomId: string,
    @Body() dto: UpdateRoomDto,
  ) {
    return this.roomsService.updateRoom(user.id, roomId, dto);
  }

  @Delete(':id')
  deleteRoom(
    @CurrentUser() user: AuthUser,
    @Param('id') roomId: string,
    @Query('forEveryone') forEveryone?: string,
  ) {
    return this.roomsService.deleteRoom(user.id, roomId, forEveryone === 'true');
  }

  @Post(':id/leave')
  leaveRoom(@CurrentUser() user: AuthUser, @Param('id') roomId: string) {
    return this.roomsService.leaveRoom(user.id, roomId);
  }

  @Post(':id/clear')
  clearHistory(@CurrentUser() user: AuthUser, @Param('id') roomId: string) {
    return this.roomsService.clearHistory(user.id, roomId);
  }

  @Post(':id/read')
  markRead(@CurrentUser() user: AuthUser, @Param('id') roomId: string) {
    return this.roomsService.markRead(user.id, roomId);
  }

  @Patch(':id/membership')
  updateMembership(
    @CurrentUser() user: AuthUser,
    @Param('id') roomId: string,
    @Body() dto: UpdateMembershipDto,
  ) {
    return this.roomsService.updateMembership(user.id, roomId, dto);
  }

  @Post(':id/members')
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('id') roomId: string,
    @Body() dto: AddMemberDto,
  ) {
    const ids = [...(dto.userIds ?? []), ...(dto.userId ? [dto.userId] : [])];
    return this.roomsService.addMembers(user.id, roomId, ids);
  }

  @Delete(':id/members/:userId')
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id') roomId: string,
    @Param('userId') targetUserId: string,
  ) {
    return this.roomsService.removeMember(user.id, roomId, targetUserId);
  }

  @Patch(':id/members/:userId/role')
  setRole(
    @CurrentUser() user: AuthUser,
    @Param('id') roomId: string,
    @Param('userId') targetUserId: string,
    @Body() dto: SetRoleDto,
  ) {
    return this.roomsService.setMemberRole(user.id, roomId, targetUserId, dto.role);
  }
}
