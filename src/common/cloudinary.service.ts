import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

/**
 * Cloudinary yapılandırması iki şekilde verilebilir:
 *  - CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
 *  - CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET
 */
@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);
  private configured: boolean = false;

  constructor() {
    this.checkConfigured();
  }

  private checkConfigured(): boolean {
    if (this.configured) return true;

    if (process.env.CLOUDINARY_URL) {
      cloudinary.config({ secure: true });
      this.configured = true;
      this.logger.log('Cloudinary CLOUDINARY_URL ile başarıyla yapılandırıldı.');
    } else if (
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
    ) {
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        secure: true,
      });
      this.configured = true;
      this.logger.log('Cloudinary API anahtarlarıyla başarıyla yapılandırıldı.');
    } else {
      this.configured = false;
    }
    return this.configured;
  }

  get isConfigured(): boolean {
    return this.checkConfigured();
  }

  uploadImage(
    buffer: Buffer,
    folder: string,
    publicId?: string,
  ): Promise<UploadApiResponse> {
    if (!this.checkConfigured()) {
      throw new ServiceUnavailableException(
        'Fotoğraf yükleme servisi (Cloudinary) yapılandırılmamış. Lütfen .env dosyasında CLOUDINARY_URL veya CLOUDINARY anahtarlarını tanımlayın.',
      );
    }

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `chrono/${folder}`,
          public_id: publicId,
          overwrite: true,
          resource_type: 'image',
          transformation: [
            { width: 640, height: 640, crop: 'fill', gravity: 'face' },
            { quality: 'auto', fetch_format: 'auto' },
          ],
        },
        (error, result) => {
          if (error || !result) {
            this.logger.error(`Cloudinary upload hatası: ${JSON.stringify(error)}`);
            const errMsg = error?.message || 'Görsel yüklenemedi';
            if (errMsg.includes('Request forbidden') || error?.http_code === 403) {
              return reject(
                new BadRequestException(
                  'Cloudinary yetki hatası (403): Kullandığınız API anahtarının yükleme (create) izni yok. Lütfen Cloudinary Dashboard ana sayfasındaki (Full/Master) anahtarları veya "CLOUDINARY_URL" değerini kullanın.',
                ),
              );
            }
            return reject(
              new BadRequestException(`Cloudinary yükleme hatası: ${errMsg}`),
            );
          }
          resolve(result);
        },
      );
      stream.end(buffer);
    });
  }

  uploadChatImage(
    buffer: Buffer,
    folder: string = 'chat_images',
    publicId?: string,
  ): Promise<UploadApiResponse> {
    if (!this.checkConfigured()) {
      throw new ServiceUnavailableException(
        'Görsel yükleme servisi (Cloudinary) yapılandırılmamış.',
      );
    }

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `chrono/${folder}`,
          public_id: publicId,
          overwrite: true,
          resource_type: 'image',
          transformation: [
            { width: 1920, height: 1920, crop: 'limit' },
            { quality: 'auto:good', fetch_format: 'auto', flags: 'strip_profile' },
          ],
        },
        (error, result) => {
          if (error || !result) {
            this.logger.error(`Cloudinary chat image upload hatası: ${JSON.stringify(error)}`);
            return reject(
              new BadRequestException(
                `Cloudinary görsel yükleme hatası: ${error?.message || 'Görsel yüklenemedi'}`,
              ),
            );
          }
          resolve(result);
        },
      );
      stream.end(buffer);
    });
  }

  uploadChatSticker(
    buffer: Buffer,
    folder: string = 'chat_stickers',
    publicId?: string,
  ): Promise<UploadApiResponse> {
    if (!this.checkConfigured()) {
      throw new ServiceUnavailableException(
        'Çıkartma yükleme servisi (Cloudinary) yapılandırılmamış.',
      );
    }

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `chrono/${folder}`,
          public_id: publicId,
          overwrite: true,
          resource_type: 'image',
          format: 'webp',
          transformation: [
            { width: 512, height: 512, crop: 'limit' },
            { quality: 'auto:good' },
          ],
        },
        (error, result) => {
          if (error || !result) {
            this.logger.error(`Cloudinary sticker upload hatası: ${JSON.stringify(error)}`);
            return reject(
              new BadRequestException(
                `Cloudinary çıkartma yükleme hatası: ${error?.message || 'Çıkartma yüklenemedi'}`,
              ),
            );
          }
          resolve(result);
        },
      );
      stream.end(buffer);
    });
  }

  uploadChatAudio(
    buffer: Buffer,
    folder: string = 'chat_audio',
    publicId?: string,
  ): Promise<UploadApiResponse> {
    if (!this.checkConfigured()) {
      throw new ServiceUnavailableException(
        'Ses yükleme servisi (Cloudinary) yapılandırılmamış.',
      );
    }

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `chrono/${folder}`,
          public_id: publicId,
          overwrite: true,
          resource_type: 'video', // Cloudinary manages audio under the 'video' resource type
        },
        (error, result) => {
          if (error || !result) {
            this.logger.error(`Cloudinary chat audio upload hatası: ${JSON.stringify(error)}`);
            return reject(
              new BadRequestException(
                `Cloudinary ses yükleme hatası: ${error?.message || 'Ses yüklenemedi'}`,
              ),
            );
          }
          resolve(result);
        },
      );
      stream.end(buffer);
    });
  }

  extractPublicId(input: string): string | null {
    if (!input) return null;
    const clean = input.trim();
    // Eğer doğrudan public_id ise (URL değilse)
    if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
      return clean;
    }
    try {
      const uploadIdx = clean.indexOf('/upload/');
      if (uploadIdx === -1) return null;
      let afterUpload = clean.substring(uploadIdx + 8);
      const queryIdx = afterUpload.indexOf('?');
      if (queryIdx !== -1) afterUpload = afterUpload.substring(0, queryIdx);
      // v12345/ gibi versiyon etiketlerini temizle
      afterUpload = afterUpload.replace(/^(?:[a-zA-Z0-9_,]+(?:\/[a-zA-Z0-9_,]+)*\/)?(?:v\d+\/)/, '');
      afterUpload = afterUpload.replace(/^v\d+\//, '');
      // Uzantıyı kaldır (.jpg, .png vs.)
      const extIdx = afterUpload.lastIndexOf('.');
      if (extIdx !== -1) afterUpload = afterUpload.substring(0, extIdx);
      return afterUpload || null;
    } catch {
      return null;
    }
  }

  async deleteImage(publicIdOrUrl: string): Promise<boolean> {
    if (!this.checkConfigured() || !publicIdOrUrl) return false;
    try {
      const publicId = this.extractPublicId(publicIdOrUrl);
      if (!publicId) return false;
      const res = await cloudinary.uploader.destroy(publicId, { invalidate: true });
      this.logger.log(`Cloudinary kullanılmayan görsel silindi: ${publicId} (durum: ${res?.result})`);
      return res?.result === 'ok';
    } catch (err) {
      this.logger.warn(`Cloudinary görsel silme hatası (${publicIdOrUrl}): ${String(err)}`);
      return false;
    }
  }
}
