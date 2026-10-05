'use strict';
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
class MockTransport extends EventEmitter {
  constructor({ project, hub }) { super(); this.project = project; this.hub = hub; this.pending = new Map(); this.seq = 0; this.state = {}; }
  async connect() {
    this.ws = new WebSocket(this.hub);
    this.ws.on('message', bytes => {
      const msg = JSON.parse(bytes.toString());
      if (msg.event) {
        if (msg.event === 'members') this.state = msg.result;
        if (msg.event === 'closed') this.state = { selfId: this.state.selfId, room: null, members: [] };
        this.emit(msg.event, msg.result); return;
      }
      const request = this.pending.get(msg.id); if (!request) return;
      this.pending.delete(msg.id); clearTimeout(request.timer);
      if (msg.error) request.reject(new Error(msg.error)); else request.resolve(msg.result);
    });
    this.ws.on('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('MOCK_DISCONNECTED')); } this.pending.clear(); });
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    this.state = await this.request('connect', { project: this.project }); return this;
  }
  request(op, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('MOCK_TIMEOUT')); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, op, ...payload }));
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
