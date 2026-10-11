import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'Geçerli bir e-posta adresi giriniz' })
  email: string;

  @IsString()
  @IsNotEmpty({ message: 'Kullanıcı adı boş bırakılamaz' })
  @MinLength(3, { message: 'Kullanıcı adı en az 3 karakter olmalıdır' })
  @MaxLength(20, { message: 'Kullanıcı adı en fazla 20 karakter olabilir' })
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'Kullanıcı adı sadece harf, rakam ve alt çizgi (_) içerebilir',
  })
  username: string;

  @IsString()
  @IsNotEmpty({ message: 'Görünen isim boş bırakılamaz' })
  @MaxLength(40, { message: 'Görünen isim en fazla 40 karakter olabilir' })
  displayName: string;

  @IsString()
  @MinLength(6, { message: 'Şifre en az 6 karakter olmalıdır' })
  password: string;

  @IsOptional()
  @IsString()
  pushToken?: string;
}

export class LoginDto {
  @IsNotEmpty({ message: 'E-posta veya kullanıcı adı giriniz' })
  identifier: string;

  @IsNotEmpty({ message: 'Şifrenizi giriniz' })
  password: string;

  @IsOptional()
  @IsString()
  pushToken?: string;
}

export class CheckUserDto {
  @IsNotEmpty({ message: 'Kullanıcı adı veya e-posta giriniz' })
  identifier: string;
}
