import type { Socket } from 'node:net';
import { CONTROL_METHODS, KernelTransport } from '../kernel-transport.js';

type Envelope = Record<string, unknown>;

/** Observe decoded boundaries without replacing real kernel execution or socket framing. */
export class TransportFixture {
  readonly sent: Envelope[] = [];
  readonly received: Envelope[] = [];
  readonly held: Envelope[] = [];
  onSend?: (value: Envelope) => void;
  onReceive?: (value: Envelope) => void;
  hold?: (value: Envelope) => boolean;
  private transport!: KernelTransport;
  private deliver!: (value: unknown) => void;
  readonly create: typeof KernelTransport.prepare = async (onFrame, onFailure, onResponseDiscarded) => {
    this.deliver = onFrame;
    const transport = await KernelTransport.prepare(value => {
      const envelope = value as Envelope;
      this.received.push(envelope);
      this.onReceive?.(envelope);
      if (this.hold?.(envelope)) this.held.push(envelope);
      else onFrame(value);
    }, onFailure, requestId => {
      this.onReceive?.({kind:'response-discarded', id:requestId});
      onResponseDiscarded(requestId);
    });
    this.transport = transport;
    const send = transport.send.bind(transport);
    transport.send = (value, lane) => {
      this.sent.push(value);
      const result = send(value, lane);
      this.onSend?.(value);
      return result;
    };
    return transport;
  };
  release(): void {
    delete this.hold;
    for (const value of this.held.splice(0)) this.deliver(value);
  }
  send(value: Envelope): Promise<void> {
    return this.transport.send(value, value.kind === 'cancel' || CONTROL_METHODS.has(String(value.method)) ? 'control' : 'data');
  }
  socket(lane: 'control' | 'data'): Socket {
    return (this.transport as unknown as {control: Socket; data: Socket})[lane];
  }
  incomingStreams(): number {
    return (this.transport as unknown as {incoming: Map<string, unknown>}).incoming.size;
  }
}
