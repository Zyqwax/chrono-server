import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Visibility } from '@prisma/client';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Görünen isim boş bırakılamaz' })
  @MaxLength(40, { message: 'Görünen isim en fazla 40 karakter olabilir' })
  displayName?: string;

  @IsOptional()
  @IsString()
  @MinLength(3, { message: 'Kullanıcı adı en az 3 karakter olmalıdır' })
  @MaxLength(20, { message: 'Kullanıcı adı en fazla 20 karakter olabilir' })
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'Kullanıcı adı sadece harf, rakam ve alt çizgi (_) içerebilir',
  })
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(70, { message: 'Hakkında en fazla 70 karakter olabilir' })
  bio?: string;

  /** null göndererek doğum günü silinebilir */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString({}, { message: 'Geçerli bir tarih giriniz' })
  birthday?: string | null;
}

export class UpdatePushTokenDto {
  @IsOptional()
  @IsString()
  pushToken?: string | null;
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Mevcut şifrenizi giriniz' })
  currentPassword: string;

  @IsString()
  @MinLength(6, { message: 'Yeni şifre en az 6 karakter olmalıdır' })
  newPassword: string;
}

export class DeleteAccountDto {
  @IsString()
  @IsNotEmpty({ message: 'Şifrenizi giriniz' })
  password: string;
}

export class UpdateSettingsDto {
  @IsOptional() @IsEnum(Visibility) lastSeenVisibility?: Visibility;
  @IsOptional() @IsEnum(Visibility) avatarVisibility?: Visibility;
  @IsOptional() @IsEnum(Visibility) bioVisibility?: Visibility;
  @IsOptional() @IsEnum(Visibility) roomInviteVisibility?: Visibility;
  @IsOptional() @IsEnum(Visibility) callVisibility?: Visibility;
  @IsOptional() @IsBoolean() readReceipts?: boolean;

  @IsOptional() @IsBoolean() notifyPrivate?: boolean;
  @IsOptional() @IsBoolean() notifyRooms?: boolean;
  @IsOptional() @IsBoolean() notifyCalls?: boolean;
  @IsOptional() @IsBoolean() messagePreview?: boolean;
  @IsOptional() @IsBoolean() inAppSounds?: boolean;
  @IsOptional() @IsBoolean() inAppVibrate?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(12)
  @Max(24)
  messageTextSize?: number;

  @IsOptional()
  @IsIn(['default', 'midnight', 'ocean', 'aurora', 'graphite', 'plain'])
  chatWallpaper?: string;

  @IsOptional() @IsBoolean() sendByEnter?: boolean;
  @IsOptional() @IsBoolean() timeFormat24h?: boolean;
}
