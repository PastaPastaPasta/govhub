// ZMQ subscriber for Dash Core's governance and block notifications.
// Core sends three frames per message: topic, body, 4-byte LE sequence number per notifier (zmqpublishnotifier.cpp:227-242).
// A PUB socket silently DROPS messages for a slow subscriber once the high-water mark is reached, but the sequence number still
// advances, so every gap is detectable here and is reported to the caller (which then reconciles over RPC).
import { Subscriber } from 'zeromq';
import { log } from '../log.ts';

export const ZMQ_TOPICS = ['rawgovernanceobject', 'rawgovernancevote', 'hashblock', 'hashchainlock'] as const;
export type ZmqTopic = (typeof ZMQ_TOPICS)[number];

export interface ZmqMessage {
  topic: ZmqTopic;
  body: Uint8Array;
  seq: number;
  receivedAt: number;
}

export interface ZmqGap {
  topic: ZmqTopic;
  expected: number;
  got: number;
}

export interface ZmqHandlers {
  onMessage(m: ZmqMessage): void | Promise<void>;
  /** A sequence gap: `got - expected` messages of `topic` were dropped (or Core restarted and reset its counters). */
  onGap?(g: ZmqGap): void;
}

/** Tracks per-topic sequence numbers. Pure, so it is unit-tested without a socket. */
export class SequenceTracker {
  private last = new Map<string, number>();

  /** Returns a gap or null. The first message of a topic never reports a gap. uint32 wrap-around is handled. */
  observe(topic: ZmqTopic, seq: number): ZmqGap | null {
    const prev = this.last.get(topic);
    this.last.set(topic, seq);
    if (prev === undefined) return null;
    const expected = (prev + 1) >>> 0;
    return seq === expected ? null : { topic, expected, got: seq };
  }
}

export class ZmqListener {
  private sock: Subscriber | null = null;
  private running = false;
  private readonly url: string;
  private readonly handlers: ZmqHandlers;
  private readonly tracker = new SequenceTracker();
  private loop: Promise<void> | null = null;
  received = 0;
  gaps = 0;
  lastMessageAt = 0;

  constructor(url: string, handlers: ZmqHandlers) {
    this.url = url;
    this.handlers = handlers;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // receiveHighWaterMark 0 = unlimited on our side; Core's publisher HWM (default 1000) is configured in dash.conf.
    const sock = new Subscriber({ receiveHighWaterMark: 0, reconnectInterval: 1000, tcpKeepalive: 1 });
    this.sock = sock;
    for (const t of ZMQ_TOPICS) sock.subscribe(t);
    sock.connect(this.url);
    void (async () => {
      try {
        for await (const ev of sock.events) {
          if (ev.type === 'connect') log.info('zmq connected', { url: this.url });
          else if (ev.type === 'disconnect') log.warn('zmq disconnected', { url: this.url });
        }
      } catch {
        /* socket closed */
      }
    })();
    this.loop = this.run(sock);
    log.info('zmq listener started', { url: this.url, topics: ZMQ_TOPICS });
  }

  private async run(sock: Subscriber): Promise<void> {
    try {
      for await (const frames of sock) {
        const [topicBuf, body, seqBuf] = frames;
        if (!topicBuf || !body) continue;
        const topic = topicBuf.toString('utf8') as ZmqTopic;
        if (!(ZMQ_TOPICS as readonly string[]).includes(topic)) continue;
        const seq = seqBuf && seqBuf.length === 4 ? seqBuf.readUInt32LE(0) : -1;
        this.received++;
        this.lastMessageAt = Date.now();
        if (seq >= 0) {
          const gap = this.tracker.observe(topic, seq);
          if (gap) {
            this.gaps++;
            log.error('zmq sequence gap: messages were dropped (or dashd restarted)', { ...gap });
            this.handlers.onGap?.(gap);
          }
        }
        try {
          await this.handlers.onMessage({ topic, body: new Uint8Array(body), seq, receivedAt: Math.floor(Date.now() / 1000) });
        } catch (e) {
          log.error('zmq handler failed', { topic, seq, error: String((e as Error)?.stack ?? e) });
        }
      }
    } catch (e) {
      if (this.running) log.error('zmq receive loop ended', { error: String(e) });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.sock) {
      this.sock.close();
      this.sock = null;
    }
    await this.loop?.catch(() => undefined);
  }
}
