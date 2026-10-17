import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { MessageType } from '@prisma/client';

export class SendMessageDto {
  @IsString()
  @IsOptional()
  @MaxLength(4096)
  content?: string;

  @IsEnum(MessageType)
  @IsOptional()
  type?: MessageType;

  @IsString()
  @IsOptional()
  ciphertext?: string;

  @IsString()
  @IsOptional()
  nonce?: string;

  @IsString()
  @IsOptional()
  senderPublicKey?: string;

  @IsString()
  @IsOptional()
  replyToId?: string;
}

export class EditMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  content: string;
}

export class ReactMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  emoji: string;
}
