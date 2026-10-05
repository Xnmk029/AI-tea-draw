'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual, randomInt } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { MAX_PACKET_BYTES, validateProject } = require('./protocol.cjs');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
async function createBridge({ root, project = 'html-coop', transport, port = 0 } = {}) {
  root = fs.realpathSync(root);
  validateProject(project);
  const token = randomBytes(32).toString('hex');
  let client = null; let closing = false; let operation = Promise.resolve();let pending=0;
  const metrics = { received: 0, sent: 0, errors: 0 };
  const server = http.createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      if (pathname === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, project, transport: transport.info().transport, metrics })); return; }
      let file;
      if (pathname === '/__steam/client.js') file = path.resolve(__dirname, '../../adapters/browser/bridge-client.js');
      else {
        const parts = pathname.split('/');
        if (parts.some(p => p.startsWith('.') || ['node_modules','steam-spacewar-multiplayer-skill','.steam-multiplayer'].includes(p))) throw new Error('PRIVATE_PATH');
        file = fs.realpathSync(path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname)));
        if (!file.startsWith(root + path.sep)) throw new Error('PRIVATE_PATH');
      }
      const type = TYPES[path.extname(file)]; if (!type) throw new Error('PRIVATE_PATH');
      let contents = fs.readFileSync(file);
      if (path.extname(file) === '.html') contents = Buffer.from(contents.toString().replace('</head>', '<script src="/__steam/client.js"></script></head>'));
      res.setHeader('Content-Type', type + (type.startsWith('text/') ? '; charset=utf-8' : ''));
      res.end(contents);
    } catch (_) { res.writeHead(404); res.end('Not found'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PACKET_BYTES });
  server.on('upgrade', (req, socket, head) => {
    let url;try{url=new URL(req.url,'http://localhost');}catch(_){socket.destroy();return;}
    const provided = Buffer.from(url.searchParams.get('token') || ''); const expected = Buffer.from(token);
    const origin = req.headers.origin;
    // TeaDraw patch: dev pages come from the vite server on another loopback port,
    // so accept any loopback origin instead of only the bridge's own HTTP port.
    let originOk = !origin;
    if (origin) {
      try { const host = new URL(origin).hostname; originOk = host === '127.0.0.1' || host === 'localhost' || host === '[::1]'; } catch (_) { /* deny */ }
    }
    if (url.pathname !== '/bridge' || provided.length !== expected.length || !timingSafeEqual(provided, expected) || !originOk) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    if (client && client.readyState === WebSocket.OPEN) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  function event(name, result) { if (client?.readyState === WebSocket.OPEN && client.bufferedAmount < 2 * MAX_PACKET_BYTES) client.send(JSON.stringify({ event: name, result })); }
  transport.on('packet', p => { metrics.received++; event('packet', p); });
  transport.on('members', p => event('members', p));
  transport.on('closed', p => event('closed', p));
  transport.on('fault', p => { metrics.errors++; event('fault', p); });
  wss.on('connection', ws => {
    client = ws; event('state', transport.info());
    ws.on('error', () => {});
    ws.on('message', bytes => {
      if(++pending>128){pending--;ws.close(1008,'BRIDGE_BACKPRESSURE');return;}
      // Serialize control operations and sends; refresh/leave cannot race with a pending lobby join.
      operation = operation.then(async () => {
        let request;
        try {
          request = JSON.parse(bytes.toString()); let result;
          if (request.op === 'create') result = await transport.createRoom();
          else if (request.op === 'join') result = await transport.joinRoom(request.room);
          else if (request.op === 'leave') { await transport.leave(); result = transport.info(); }
          else if (request.op === 'send') {
            if (!request.data || typeof request.data !== 'object' || Array.isArray(request.data)) throw new Error('INVALID_MESSAGE');
            if (ws.bufferedAmount > 2 * MAX_PACKET_BYTES) throw new Error('BRIDGE_BACKPRESSURE');
            await transport.send(String(request.to), request.data); metrics.sent++; result = { ok: true };
          } else throw new Error('UNKNOWN_OPERATION');
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: request.id, result }));
        } catch (e) {
          metrics.errors++; if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: request?.id, error: e.message }));
        } finally {pending--;}
      });
    });
    ws.on('close', () => {
      if (client === ws) client = null;
      if (!closing) operation = operation.then(() => transport.leave()).catch(() => {});
    });
  });
  // Some Windows installations allocate low ports for listen(0), including
  // browser-blocked services such as 1723. Bind high ports atomically instead.
  let bound=false;
  for(let attempt=0;attempt<32&&!bound;attempt++){
    try{
      await new Promise((resolve,reject)=>{
        const error=e=>{server.off('listening',ready);reject(e);};
        const ready=()=>{server.off('error',error);resolve();};
        server.once('error',error);server.once('listening',ready);server.listen(port||randomInt(20000,60000),'127.0.0.1');
      });bound=true;
    }catch(e){if(port||!['EADDRINUSE','EACCES'].includes(e.code)||attempt===31)throw e;}
  }
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, token, url: `${base}/index.html?steam=1#token=${token}`, transport, metrics,
    close: async () => { closing = true; for (const ws of wss.clients) ws.terminate(); await operation; await transport.close(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); }
  };
}
function args(argv) { const out = {}; for (let i = 0; i < argv.length; i += 2) { if (!argv[i].startsWith('--') || !argv[i+1]) throw new Error('INVALID_ARGUMENTS'); out[argv[i].slice(2)] = argv[i+1]; } return out; }
if (require.main === module) {
  (async () => {
    const options = args(process.argv.slice(2)); const project = options.project || 'yuanqi-knight-coop';
    let transport;
    if (options.transport === 'mock') { const { MockTransport } = require('./mock-transport.cjs'); transport = await new MockTransport({ project, hub: options.hub || 'ws://127.0.0.1:19780' }).connect(); }
    else { const { SteamTransport } = require('./steam-transport.cjs'); transport = new SteamTransport({ project, appId: Number(options.appid) || 480 }); }
    const bridge = await createBridge({ root: path.resolve(options.root || '..'), project, transport, port: Number(options.port) || 0 });
    console.log(JSON.stringify({ event: 'ready', url: bridge.url, transport: transport.info().transport }));
    if(options.open==='true'){
      const {spawn}=require('node:child_process');
      if(process.platform==='win32'){const script=`Start-Process -FilePath '${bridge.url}'`;spawn('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:'ignore'}).unref();}
      else spawn(process.platform==='darwin'?'open':'xdg-open',[bridge.url],{stdio:'ignore'}).unref();
    }
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await bridge.close(); process.exit(0); });
  })().catch(e => { console.error(JSON.stringify({ status: 'blocked', code: 'BRIDGE_START_FAILED', message: e.message })); process.exit(2); });
}
module.exports = { createBridge, args };
