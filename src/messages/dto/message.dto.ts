import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class SendMessageDto {
  @IsString()
  @IsOptional()
  @MaxLength(4096)
  content?: string;

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
