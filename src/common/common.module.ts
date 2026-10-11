import { Global, Module } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service';
import { RealtimeService } from './realtime.service';
import { PrivacyService } from './privacy.service';

@Global()
@Module({
  providers: [CloudinaryService, RealtimeService, PrivacyService],
  exports: [CloudinaryService, RealtimeService, PrivacyService],
})
export class CommonModule {}
