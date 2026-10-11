import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { PrivacyService } from '../common/privacy.service';
import { publicUserSelect } from '../common/constants';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';

export class AddContactDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  nickname?: string;
}

export class UpdateContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  nickname?: string;
}

@Injectable()
export class ContactsService {
  constructor(
    private prisma: PrismaService,
    private privacy: PrivacyService,
  ) {}

  async list(ownerId: string) {
    const rows = await this.prisma.contact.findMany({
      where: { ownerId },
      include: { contact: { select: publicUserSelect } },
    });
    const users = await this.privacy.filterUsers(
      ownerId,
      rows.map((r) => r.contact),
    );
    const userMap = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({
      id: r.id,
      nickname: r.nickname,
      createdAt: r.createdAt,
      user: userMap.get(r.contactId)!,
    }));
  }

  async add(ownerId: string, dto: AddContactDto) {
    if (dto.userId === ownerId) {
      throw new BadRequestException('Kendinizi kişi olarak ekleyemezsiniz');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: publicUserSelect,
    });
    if (!target) throw new NotFoundException('Kullanıcı bulunamadı');

    const row = await this.prisma.contact.upsert({
      where: { ownerId_contactId: { ownerId, contactId: dto.userId } },
      update: { nickname: dto.nickname ?? undefined },
      create: { ownerId, contactId: dto.userId, nickname: dto.nickname },
    });
    return {
      id: row.id,
      nickname: row.nickname,
      createdAt: row.createdAt,
      user: await this.privacy.filterUser(ownerId, target),
    };
  }

  async update(ownerId: string, contactUserId: string, dto: UpdateContactDto) {
    const row = await this.prisma.contact.findUnique({
      where: { ownerId_contactId: { ownerId, contactId: contactUserId } },
    });
    if (!row) throw new NotFoundException('Kişi bulunamadı');
    return this.prisma.contact.update({
      where: { id: row.id },
      data: { nickname: dto.nickname?.trim() || null },
    });
  }

  async remove(ownerId: string, contactUserId: string) {
    await this.prisma.contact.deleteMany({
      where: { ownerId, contactId: contactUserId },
    });
    return { success: true };
  }
}

@Controller('contacts')
@UseGuards(JwtAuthGuard)
export class ContactsController {
  constructor(private contacts: ContactsService) {}

  @Get()
  list(@CurrentUser() user: { id: string }) {
    return this.contacts.list(user.id);
  }

  @Post()
  add(@CurrentUser() user: { id: string }, @Body() dto: AddContactDto) {
    return this.contacts.add(user.id, dto);
  }

  @Patch(':userId')
  update(
    @CurrentUser() user: { id: string },
    @Param('userId') userId: string,
    @Body() dto: UpdateContactDto,
  ) {
    return this.contacts.update(user.id, userId, dto);
  }

  @Delete(':userId')
  remove(@CurrentUser() user: { id: string }, @Param('userId') userId: string) {
    return this.contacts.remove(user.id, userId);
  }
}

@Module({
  controllers: [ContactsController],
  providers: [ContactsService],
})
export class ContactsModule {}
