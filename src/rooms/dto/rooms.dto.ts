import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Role } from '@prisma/client';

export class CreateRoomDto {
  @IsString()
  @IsNotEmpty({ message: 'Sohbet odası adı boş bırakılamaz' })
  @MaxLength(60)
  name: string;

  @IsOptional()
  @IsString()
  iconUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  /** Oluştururken eklenecek üyeler */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  memberIds?: string[];
}

export class UpdateRoomDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  iconUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}

export class AddMemberDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  userIds?: string[];
}

export class OpenDirectDto {
  @IsString()
  @IsNotEmpty()
  userId: string;
}

export class UpdateMembershipDto {
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;

  /** null → sessizden çıkar; ISO tarih → o tarihe kadar sessiz */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  mutedUntil?: string | null;
}

export class SetRoleDto {
  @IsEnum(Role)
  role: Role;
}

export class DeleteRoomQuery {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  forEveryone?: boolean;
}
