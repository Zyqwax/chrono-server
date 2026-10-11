import { Global, Module } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service';
import { RealtimeService } from './realtime.service';
import { PrivacyService } from './privacy.service';
import { PushNotificationService } from './push-notification.service';

@Global()
@Module({
  providers: [
    CloudinaryService,
    RealtimeService,
    PrivacyService,
    PushNotificationService,
  ],
  exports: [
    CloudinaryService,
    RealtimeService,
    PrivacyService,
    PushNotificationService,
  ],
})
export class CommonModule {}
