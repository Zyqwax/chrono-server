import { Injectable } from '@nestjs/common';
import { AccessToken } from 'livekit-server-sdk';

@Injectable()
export class LivekitService {
  private apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
  private apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
  private livekitUrl = process.env.LIVEKIT_URL || 'http://localhost:7880';

  async generateToken(
    roomName: string,
    participantIdentity: string,
    participantName: string,
  ) {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: participantIdentity,
      name: participantName,
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    return {
      serverUrl: this.livekitUrl,
      token,
      roomName,
    };
  }
}
