import { Trickle } from '../client';
import { IonSFUJSONRPCSignal } from './json-rpc-impl';

export { Trickle, IonSFUJSONRPCSignal };

export interface Signal {
  onnegotiate?: (jsep: RTCSessionDescriptionInit) => void;
  ontrickle?: (trickle: Trickle) => void;
  chatMessage: (data: any) => void;
  join(sid: string, uid: null | string, offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit>;
  offer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit>;
  answer(answer: RTCSessionDescriptionInit): void;
  trickle(trickle: Trickle): void;
  close(): void;
}
