const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
export function connectorEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('Host URL cannot contain credentials, query or fragment');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP(S) Application Host');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return new URL('api/browser-resources/connector/exchange', url).href;
}
/** Shared HTTP transport for the browser extension and optional native launcher. */
export class ConnectorBridge {
  constructor({ endpoint, clientToken, send, fetch = globalThis.fetch, onStop = () => {}, pollMs = 400 }) {
    this.endpoint = connectorEndpoint(endpoint); this.clientToken = clientToken; this.send = send;
    this.fetch = fetch; this.onStop = onStop; this.pollMs = pollMs;
    this.events = []; this.results = []; this.hello = undefined; this.timer = undefined; this.pending = false;
    this.stopped = false; this.controller = new AbortController(); this.commandIds = new Set(); this.lastSequence = 0;
  }
  accept(message) {
    if (this.stopped || !isRecord(message)) return;
    if (message.type === 'goodbye') { void this.closeGracefully(); return; }
    if (message.type === 'hello') {
      if (this.hello) throw new Error('A browser connection cannot replace its browser identity');
      const { browserId, instanceId, label, capabilities } = message;
      if (![browserId, instanceId, label].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200)
        || !Array.isArray(capabilities) || capabilities.length > 64 || !capabilities.every(value => typeof value === 'string' && value.length < 100)) throw new Error('Invalid browser connector identity');
      this.hello = { browserId, instanceId, label, capabilities };
    } else if (message.type === 'event' && this.hello && isRecord(message.event)) this.events.push(message.event);
    else if (message.type === 'result' && this.hello && isRecord(message.result) && this.commandIds.has(message.result.id)) {
      this.commandIds.delete(message.result.id); this.results.push(message.result);
    }
    else throw new Error('Unexpected browser transport message');
    this.wake();
  }
  wake() {
    if (this.stopped || this.pending || !this.hello) return;
    clearTimeout(this.timer); this.timer = undefined;
    void this.exchange();
  }
  async exchange() {
    if (this.pending || this.stopped) return;
    this.pending = true;
    // Removing this batch is intentional. A failed exchange ends the instance;
    // neither commands nor uncertain results are automatically retransmitted.
    const body = { ...this.hello, events: this.events.splice(0), results: this.results.splice(0) };
    try {
      const response = await this.fetch(this.endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${this.clientToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error', credentials: 'omit',
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(25000)]),
      });
      if (!response.ok) throw new Error('The paired Host rejected the browser connector');
      const reply = await response.json();
      if (!isRecord(reply) || !Array.isArray(reply.commands) || reply.commands.length > 128) throw new Error('Invalid connector reply');
      if (this.stopped) return;
      if (!this.connected) { this.connected = true; this.send({ type: 'connected' }); }
      for (const command of reply.commands) {
        if (!isRecord(command) || typeof command.id !== 'string' || !Array.isArray(command.args)
          || !Number.isSafeInteger(command.sequence) || command.sequence <= 0) throw new Error('Invalid browser command');
        if (command.sequence <= this.lastSequence) {
          if (!this.commandIds.has(command.id)) this.results.push({ id: command.id, ok: false, effect: 'none',
            error: 'This command sequence was already consumed. Reconnect and re-share after a Host restart.' });
          continue;
        }
        if (this.commandIds.has(command.id)) throw new Error('A pending command cannot change identity');
        this.lastSequence = command.sequence; this.commandIds.add(command.id); this.send({ type: 'command', command });
      }
    } catch {
      // Error text can include secret URLs or page content. Report only a fixed status.
      this.stop(); return;
    } finally { this.pending = false; }
    if (this.events.length || this.results.length) this.wake();
    else this.timer = setTimeout(() => this.wake(), this.pollMs);
  }
  async closeGracefully() {
    if (this.stopped) return;
    if (!this.connected || !this.hello) { this.stop(); return; }
    // Abort an idle long poll and make exactly one terminal exchange. All local
    // tab scopes were revoked first. This is not a retry of the aborted batch.
    this.stopped = true; clearTimeout(this.timer); this.controller.abort();
    try {
      await this.fetch(this.endpoint, { method: 'POST',
        headers: { Authorization: `Bearer ${this.clientToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...this.hello, events: this.events.splice(0), results: this.results.splice(0), disconnected: true }),
        redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(25000) });
    } catch { /* The original Host timeout remains authoritative if delivery failed. */ }
    finally { try { this.send({ type: 'disconnected' }); } finally { this.onStop(); } }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.timer); this.controller.abort();
    try { this.send({ type: 'disconnected' }); } finally { this.onStop(); }
  }
}
