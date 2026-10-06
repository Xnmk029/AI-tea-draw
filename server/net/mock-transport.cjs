'use strict';
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
class MockTransport extends EventEmitter {
  constructor({ project, hub }) { super(); this.project = project; this.hub = hub; this.pending = new Map(); this.seq = 0; this.state = {}; }
  async connect() {
    this.ws = new WebSocket(this.hub);
    this.ws.on('message', bytes => {
      let msg;
      try { msg = JSON.parse(bytes.toString()); } catch (_) { this.emit('fault', { code: 'INVALID_MESSAGE' }); return; }
      if (msg.event) {
        if (msg.event === 'members') this.state = msg.result;
        if (msg.event === 'closed') this.state = { selfId: this.state.selfId, room: null, hostId: null, members: [], transport: 'mock' };
        this.emit(msg.event, msg.result); return;
      }
      const request = this.pending.get(msg.id); if (!request) return;
      this.pending.delete(msg.id); clearTimeout(request.timer);
      if (msg.error) request.reject(new Error(msg.error)); else request.resolve(msg.result);
    });
    this.ws.on('error', e => this.emit('fault', { code: 'MOCK_CONNECTION_ERROR', message: e.message }));
    this.ws.on('close', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('MOCK_DISCONNECTED')); }
      this.pending.clear();
      this.state = { selfId: this.state.selfId, room: null, hostId: null, members: [], transport: 'mock' };
      this.emit('closed', { reason: 'MOCK_DISCONNECTED' });
    });
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    this.state = await this.request('connect', { project: this.project }); return this;
  }
  request(op, payload = {}) {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('MOCK_DISCONNECTED'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('MOCK_TIMEOUT')); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, op, ...payload })); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  info() { return this.state; }
  async createRoom() { return this.state = await this.request('create'); }
  async joinRoom(room) { return this.state = await this.request('join', { room }); }
  send(to, data) { return this.request('send', { to, data }); }
  async leave() { if (this.ws?.readyState === WebSocket.OPEN) this.state = await this.request('leave'); }
  async close() { await this.leave(); this.ws?.close(); this.removeAllListeners(); }
}
module.exports = { MockTransport };
