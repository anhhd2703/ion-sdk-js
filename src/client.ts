import { Signal } from './signal';
import { LocalStream, makeRemote, RemoteStream } from './stream';
const API_CHANNEL = 'ion-sfu';
const API_CHAT = 'chat_channel'
const ERR_NO_SESSION = 'no active session, join first';

export interface Sender {
  stream: MediaStream;
  transceivers: { [kind in 'video' | 'audio']: RTCRtpTransceiver };
}

export interface Configuration extends RTCConfiguration {
  codec: 'vp8' | 'vp9' | 'h264';
}

export interface Trickle {
  candidate: RTCIceCandidateInit;
  target: Role;
}

enum Role {
  pub = 0,
  sub = 1,
}

type Transports<T extends string | symbol | number, U> = {
  [K in T]: U;
};

export class Transport {
  api?: RTCDataChannel;
  signal: Signal;
  pc: RTCPeerConnection;
  candidates: RTCIceCandidateInit[];
  chatAPI?: RTCDataChannel;
  constructor(role: Role, signal: Signal, config: RTCConfiguration) {
    this.signal = signal;

    this.pc = new RTCPeerConnection(config);
    this.candidates = [];

    if (role === Role.pub) {
      this.pc.createDataChannel(API_CHANNEL);
      this.chatAPI = this.pc.createDataChannel(API_CHAT)
    }

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.signal.trickle({ target: role, candidate });
      }
    };

    this.pc.oniceconnectionstatechange = async (e) => {
      if (this.pc.iceConnectionState === 'disconnected') {
        if (this.pc.restartIce) {
          // this will trigger onNegotiationNeeded
          this.pc.restartIce();
        }
      }
    };
  }
}

export default class Client {
  transports?: Transports<Role, Transport>;
  private config: Configuration;
  private signal: Signal;
  sid?: string;
  ontrack?: (track: MediaStreamTrack, stream: RemoteStream) => void;
  removeTrack?: (track: MediaStreamTrack) => void;
  ondatachannel?: (ev: RTCDataChannelEvent) => void;
  onspeaker?: (ev: string[]) => void;

  constructor(
    signal: Signal,
    config: Configuration = {
      codec: 'vp8',
      iceServers: [
        {
          urls: ['stun:stun.l.google.com:19302'],
        },
      ],
    },
  ) {
    this.signal = signal;
    this.config = config;
    signal.onnegotiate = this.negotiate.bind(this);
    signal.ontrickle = this.trickle.bind(this);
  }

  async join(sid: string, uid: string) {
    this.transports = {
      [Role.pub]: new Transport(Role.pub, this.signal, this.config),
      [Role.sub]: new Transport(Role.sub, this.signal, this.config),
    };
    this.sid = sid
    this.transports[Role.sub].pc.ontrack = (ev: RTCTrackEvent) => {
      const stream = ev.streams[0];
      stream.onremovetrack = ({ track }) => {
        if (this.removeTrack) {
          this.removeTrack(track)
        }
        if (!stream.getTracks().length) {
          console.log(`stream ${stream.id} emptied (effectively removed).`);
        }
      };
      const remote = makeRemote(stream, this.transports![Role.sub]);
      if (this.ontrack) {
        this.ontrack(ev.track, remote);
      }
    };

    this.transports[Role.sub].pc.ondatachannel = (ev: RTCDataChannelEvent) => {
      if (ev.channel.label === API_CHANNEL) {
        this.transports![Role.sub].api = ev.channel;
        ev.channel.onmessage = (e) => {
          if (this.onspeaker) {
            this.onspeaker(JSON.parse(e.data));
          }
        };
        return;
      }
      if (this.ondatachannel) {
        this.ondatachannel(ev);
      }
    }


    const offer = await this.transports[Role.pub].pc.createOffer();
    await this.transports[Role.pub].pc.setLocalDescription(offer);
    const answer = await this.signal.join(sid, uid, offer);
    await this.transports[Role.pub].pc.setRemoteDescription(answer);
    this.transports[Role.pub].candidates.forEach((c) => this.transports![Role.pub].pc.addIceCandidate(c));
    this.transports[Role.pub].pc.onnegotiationneeded = this.onNegotiationNeeded.bind(this);
  }
  chatMessage(data: any) {
    if (this.transports) {
      if (this.transports[Role.pub]?.chatAPI?.readyState === "open") {
        this.transports[Role.pub]?.chatAPI?.send(JSON.stringify(data));
      }
    }
  }
  leave() {
    if (this.transports) {
      Object.values(this.transports).forEach((t) => t.pc.close());
      delete this.transports;
    }
  }
  getPubStats(selector?: MediaStreamTrack) {
    if (!this.transports) {
      throw Error(ERR_NO_SESSION);
    }
    return this.transports[Role.pub].pc.getStats(selector)
      .then(stats => {
        let video: any = []
        let audio: any = []
        stats.forEach(report => {
          if (report.type === "outbound-rtp" && report.kind === "video") {
            video.push(report)
          }
          if (report.type === "outbound-rtp" && report.kind === "audio") {
            audio.push(report)
          }
        }
        )
        return { video, audio }
      });
  }

  getSubStats(selector?: MediaStreamTrack) {
    if (!this.transports) {
      throw Error(ERR_NO_SESSION);
    }
    return this.transports[Role.sub].pc.getStats(selector)
      .then(stats => {
        let video: any = []
        let audio: any = []
        stats.forEach(report => {
          if (report.type === "inbound-rtp" && report.kind === "video") {
            video.push(report)
          }
          if (report.type === "inbound-rtp" && report.kind === "audio") {
            audio.push(report)
          }

        }
        )
        return { video, audio }
      })
  }

  publish(stream: LocalStream) {
    if (!this.transports) {
      throw Error(ERR_NO_SESSION);
    }
    stream.publish(this.transports[Role.pub].pc);
  }

  createDataChannel(label: string) {
    if (!this.transports) {
      throw Error(ERR_NO_SESSION);
    }
    return this.transports[Role.pub].pc.createDataChannel(label);
  }




  close() {
    if (this.transports) {
      Object.values(this.transports).forEach((t) => t.pc.close());
    }
    this.signal.close();
  }

  private trickle({ candidate, target }: Trickle) {
    if (!this.transports) {
      throw Error(ERR_NO_SESSION);
    }
    if (this.transports[target].pc.remoteDescription) {
      this.transports[target].pc.addIceCandidate(candidate);
    } else {
      this.transports[target].candidates.push(candidate);
    }
  }

  private async negotiate(description: RTCSessionDescriptionInit) {
    if (!this.transports) {
      throw Error(ERR_NO_SESSION);
    }

    try {
      await this.transports[Role.sub].pc.setRemoteDescription(description);
      this.transports[Role.sub].candidates.forEach((c) => this.transports![Role.sub].pc.addIceCandidate(c));
      this.transports[Role.sub].candidates = [];
      const answer = await this.transports[Role.sub].pc.createAnswer();
      await this.transports[Role.sub].pc.setLocalDescription(answer);
      this.signal.answer(answer);
    } catch (err) {
      /* tslint:disable-next-line:no-console */
      console.error(err);
    }
  }

  private async onNegotiationNeeded() {
    if (!this.transports) {
      throw Error(ERR_NO_SESSION);
    }

    try {
      const offer = await this.transports[Role.pub].pc.createOffer();
      await this.transports[Role.pub].pc.setLocalDescription(offer);
      const answer = await this.signal.offer(offer);
      await this.transports[Role.pub].pc.setRemoteDescription(answer);
    } catch (err) {
      /* tslint:disable-next-line:no-console */
      console.error(err);
    }
  }
}
