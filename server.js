'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

// Minimal WebSocket server using Node's built-in modules (no runtime dependencies).
class MiniWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = MiniWebSocket.OPEN;
    this.buffer = Buffer.alloc(0);
    this.closedEmitted = false;
    socket.on('data', chunk => this.consume(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }
  send(value) {
    if (this.readyState !== MiniWebSocket.OPEN) return;
    this.writeFrame(0x1, Buffer.from(String(value)));
  }
  close() {
    if (this.readyState !== MiniWebSocket.OPEN) return;
    this.readyState = MiniWebSocket.CLOSING;
    try { this.writeFrame(0x8, Buffer.alloc(0)); this.socket.end(); } catch { this.socket.destroy(); }
  }
  writeFrame(opcode, payload) {
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2); header[1] = length;
    } else if (length <= 65535) {
      header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, payload]));
  }
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length >= 2) {
        const first = this.buffer[0], second = this.buffer[1];
        const opcode = first & 0x0f;
        const masked = Boolean(second & 0x80);
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (this.buffer.length < 4) return;
          length = this.buffer.readUInt16BE(2); offset = 4;
        } else if (length === 127) {
          if (this.buffer.length < 10) return;
          const wideLength = this.buffer.readBigUInt64BE(2);
          if (wideLength > BigInt(this.maxPayload)) throw new Error('Frame too large');
          length = Number(wideLength); offset = 10;
        }
        if (length > this.maxPayload) throw new Error('Frame too large');
        let mask;
        if (masked) {
          if (this.buffer.length < offset + 4) return;
          mask = this.buffer.subarray(offset, offset + 4); offset += 4;
        }
        if (this.buffer.length < offset + length) return;
        const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
        this.buffer = this.buffer.subarray(offset + length);
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 0x8) {
          if (this.readyState === MiniWebSocket.OPEN) this.writeFrame(0x8, payload);
          this.readyState = MiniWebSocket.CLOSING; this.socket.end(); this.finish(); return;
        }
        if (opcode === 0x9) { this.writeFrame(0xA, payload); continue; }
        if (opcode === 0x1) this.emit('message', payload);
      }
    } catch { this.socket.destroy(); this.finish(); }
  }
  finish() {
    if (this.closedEmitted) return;
    this.closedEmitted = true; this.readyState = MiniWebSocket.CLOSED; this.emit('close');
  }
}
class MiniWebSocketServer extends EventEmitter {
  constructor({ server, maxPayload = 2 * 1024 * 1024 }) {
    super();
    this.maxPayload = maxPayload;
    server.on('upgrade', (req, socket, head) => {
      const key = req.headers['sec-websocket-key'];
      if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      const client = new MiniWebSocket(socket, this.maxPayload);
      this.emit('connection', client, req);
      if (head && head.length) client.consume(head);
    });
  }
}
const WebSocket = MiniWebSocket;
const WebSocketServer = MiniWebSocketServer;

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();
const MAX_PLAYERS = 12;
const MAX_TEXT = 320;
const MAX_IMAGE_LENGTH = 1_500_000;
const MODES = new Set(['classic', 'draw', 'phrase', 'sprint']);

const OFFLINE_IMAGE = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="550" viewBox="0 0 900 550"><rect width="900" height="550" fill="#fffaf3"/><path d="M270 280 Q450 100 630 280 Q450 460 270 280Z" fill="#f1e5d4" stroke="#b59b80" stroke-width="9"/><circle cx="405" cy="260" r="22" fill="#8f7861"/><circle cx="495" cy="260" r="22" fill="#8f7861"/><path d="M410 330 Q450 365 490 330" fill="none" stroke="#8f7861" stroke-width="10" stroke-linecap="round"/><text x="450" y="430" text-anchor="middle" font-family="Arial" font-size="27" fill="#8f7861">disegno non inviato</text></svg>'
).toString('base64');

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  const requested = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

function cleanName(value) {
  return String(value || 'Anonimo').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18) || 'Anonimo';
}
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function error(ws, message) { send(ws, { type: 'error', message }); }
function getRoom(ws) { return ws.roomCode ? rooms.get(ws.roomCode) : null; }
function getPlayer(room, id) { return room.players.find(p => p.id === id); }
function migrateHost(room) {
  if (room.hostId && getPlayer(room, room.hostId)?.connected) return;
  const nextHost = room.players.find(p => p.connected);
  if (nextHost) room.hostId = nextHost.id;
}

function taskFor(room, player) {
  const game = room.game;
  if (game.phase === 'intro') {
    const type = game.mode === 'draw' ? 'draw' : 'text';
    return {
      type,
      prompt: type === 'draw'
        ? 'Disegna qualcosa di buffo: sarà il primo anello della catena.'
        : game.mode === 'phrase'
          ? 'Inventa una frase assurda per iniziare la catena.'
          : 'Scrivi una frase da far interpretare agli altri.',
      item: null
    };
  }
  const playerIndex = room.players.findIndex(p => p.id === player.id);
  const count = room.players.length;
  const bookIndex = (playerIndex - game.round + count) % count;
  const book = game.books[bookIndex];
  const last = book.entries[book.entries.length - 1];
  let type;
  if (game.mode === 'draw') type = 'draw';
  else if (game.mode === 'phrase') type = 'text';
  else type = last.type === 'text' ? 'draw' : 'text';
  return {
    type,
    prompt: type === 'draw'
      ? (game.mode === 'draw' ? 'Guarda il disegno precedente e crea la tua versione.' : 'Disegna quello che immagini leggendo la frase.')
      : (game.mode === 'phrase' ? 'Continua la storia con una nuova frase.' : 'Guarda il disegno e scrivi cosa pensi rappresenti.'),
    item: { type: last.type, content: last.content, authorName: last.authorName }
  };
}

function playerState(room, player) {
  const game = room.game;
  const payload = {
    type: 'state',
    status: game ? 'game' : 'lobby',
    room: { code: room.code, hostId: room.hostId, settings: room.settings },
    you: { id: player.id, isHost: player.id === room.hostId },
    players: room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, isHost: p.id === room.hostId })),
  };
  if (!game) return payload;
  payload.game = {
    phase: game.phase,
    mode: game.mode,
    round: game.round,
    maxRounds: game.maxRounds,
    submitted: Object.keys(game.submissions).length,
    total: room.players.length,
    timer: game.mode === 'sprint' ? 40 : room.settings.timer,
    youSubmitted: Boolean(game.submissions[player.id]),
  };
  if (game.phase === 'reveal') {
    payload.game.books = game.books.map(book => ({
      ownerName: book.ownerName,
      entries: book.entries.map(entry => ({ type: entry.type, content: entry.content, authorName: entry.authorName, strokes: entry.strokes || [] }))
    }));
  } else if (!game.submissions[player.id]) {
    payload.game.task = taskFor(room, player);
  }
  return payload;
}

function broadcast(room) {
  for (const player of room.players) send(player.ws, playerState(room, player));
}

function addOfflineSubmissions(room) {
  const game = room.game;
  if (!game || game.phase === 'reveal') return;
  for (const player of room.players) {
    if (player.connected || game.submissions[player.id]) continue;
    const task = taskFor(room, player);
    game.submissions[player.id] = {
      type: task.type,
      content: task.type === 'draw' ? OFFLINE_IMAGE : 'Il giocatore si è disconnesso 👻',
      authorId: player.id,
      authorName: player.name,
      strokes: [],
    };
  }
}

function completeIfReady(room) {
  const game = room.game;
  if (!game || game.phase === 'reveal') return;
  if (!room.players.every(player => game.submissions[player.id])) return;

  if (game.phase === 'intro') {
    for (const player of room.players) {
      const submission = game.submissions[player.id];
      const book = game.books.find(b => b.ownerId === player.id);
      book.entries.push({ ...submission });
    }
    game.phase = 'playing';
    game.round = 1;
    game.submissions = {};
    addOfflineSubmissions(room);
    completeIfReady(room);
    return;
  }

  for (const player of room.players) {
    const playerIndex = room.players.findIndex(p => p.id === player.id);
    const bookIndex = (playerIndex - game.round + room.players.length) % room.players.length;
    const book = game.books[bookIndex];
    book.entries.push({ ...game.submissions[player.id] });
  }

  if (game.round >= game.maxRounds) {
    game.phase = 'reveal';
    game.submissions = {};
    return;
  }
  game.round += 1;
  game.submissions = {};
  addOfflineSubmissions(room);
  completeIfReady(room);
}

function sanitizeStrokes(rawStrokes) {
  if (!Array.isArray(rawStrokes)) return [];
  const result = [];
  let remainingPoints = 3000;
  for (const stroke of rawStrokes.slice(0, 500)) {
    if (stroke?.clear === true) { result.push({ clear: true }); continue; }
    if (!Array.isArray(stroke?.points) || !stroke.points.length || remainingPoints <= 0) continue;
    const color = /^#[0-9a-f]{6}$/i.test(String(stroke.color || '')) ? String(stroke.color) : '#25231f';
    const width = Math.max(1, Math.min(40, Number(stroke.width) || 5));
    const points = [];
    for (const point of stroke.points.slice(0, remainingPoints)) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const x = Number(point[0]), y = Number(point[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      points.push([Math.max(0, Math.min(900, x)), Math.max(0, Math.min(550, y))]);
    }
    if (points.length) { result.push({ color, width, points }); remainingPoints -= points.length; }
  }
  return result;
}

function submit(room, player, rawContent, rawStrokes) {
  const game = room.game;
  if (!game || game.phase === 'reveal') return 'La partita è già terminata.';
  if (game.submissions[player.id]) return 'Hai già inviato questo turno.';
  const task = taskFor(room, player);
  const content = String(rawContent || '').trim();
  if (!content) return 'Aggiungi un contenuto prima di inviare.';
  if (task.type === 'text' && content.length > MAX_TEXT) return `Il testo può contenere al massimo ${MAX_TEXT} caratteri.`;
  if (task.type === 'draw') {
    if (content.length > MAX_IMAGE_LENGTH || !/^data:image\/(png|jpeg|svg\+xml);base64,/.test(content)) {
      return 'Il disegno non è valido o è troppo grande. Prova a semplificarlo.';
    }
  }
  game.submissions[player.id] = {
    type: task.type,
    content,
    authorId: player.id,
    authorName: player.name,
    strokes: task.type === 'draw' ? sanitizeStrokes(rawStrokes) : [],
  };
  completeIfReady(room);
  return null;
}

wss.on('connection', (ws) => {
  ws.on('message', (buffer) => {
    let msg;
    try { msg = JSON.parse(buffer.toString()); } catch { return error(ws, 'Messaggio non valido.'); }
    const action = msg.action;

    // Lightweight app-level heartbeat for browser clients behind idle-sleeping hosts.
    if (action === 'heartbeat') return;

    if (action === 'create') {
      const playerId = String(msg.playerId || '').slice(0, 80);
      if (!playerId) return error(ws, 'Identificativo giocatore mancante.');
      const name = cleanName(msg.name);
      const code = newCode();
      const room = {
        code,
        hostId: playerId,
        settings: { mode: 'classic', timer: 90 },
        players: [{ id: playerId, name, connected: true, ws }],
        game: null,
      };
      rooms.set(code, room);
      ws.roomCode = code; ws.playerId = playerId;
      return broadcast(room);
    }

    if (action === 'join') {
      const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
      const playerId = String(msg.playerId || '').slice(0, 80);
      const room = rooms.get(code);
      if (!room) return error(ws, 'Non trovo questa stanza. Controlla il codice e riprova.');
      if (!playerId) return error(ws, 'Identificativo giocatore mancante.');
      let player = getPlayer(room, playerId);
      if (!player && room.game) return error(ws, 'La partita è già iniziata: non puoi entrare adesso.');
      if (!player && room.players.length >= MAX_PLAYERS) return error(ws, `La stanza ha raggiunto il limite di ${MAX_PLAYERS} giocatori.`);
      if (!player) {
        player = { id: playerId, name: cleanName(msg.name), connected: true, ws };
        room.players.push(player);
      } else {
        if (player.ws && player.ws !== ws) {
          try { player.ws.close(); } catch { /* ignore */ }
        }
        player.name = cleanName(msg.name || player.name);
        player.connected = true;
        player.ws = ws;
      }
      ws.roomCode = code; ws.playerId = playerId;
      return broadcast(room);
    }

    const room = getRoom(ws);
    if (!room) return error(ws, 'Non sei in una stanza.');
    const player = getPlayer(room, ws.playerId);
    if (!player) return error(ws, 'Giocatore non trovato.');

    if (action === 'settings') {
      if (player.id !== room.hostId || room.game) return error(ws, 'Solo il creatore può cambiare le impostazioni nella lobby.');
      if (MODES.has(msg.mode)) room.settings.mode = msg.mode;
      const timer = Number(msg.timer);
      if ([45, 60, 90, 120].includes(timer)) room.settings.timer = timer;
      return broadcast(room);
    }

    if (action === 'start') {
      if (player.id !== room.hostId) return error(ws, 'Solo il creatore può avviare la partita.');
      const connected = room.players.filter(p => p.connected);
      if (connected.length < 2) return error(ws, 'Servono almeno 2 giocatori collegati per iniziare.');
      room.players = connected;
      room.game = {
        phase: 'intro', mode: room.settings.mode, round: 0,
        maxRounds: room.players.length - 1,
        books: room.players.map(p => ({ ownerId: p.id, ownerName: p.name, entries: [] })),
        submissions: {},
      };
      return broadcast(room);
    }

    if (action === 'submit') {
      const message = submit(room, player, msg.content, msg.strokes);
      if (message) return error(ws, message);
      return broadcast(room);
    }

    if (action === 'backToLobby') {
      if (player.id !== room.hostId || !room.game || room.game.phase !== 'reveal') return error(ws, 'Non puoi tornare alla lobby in questo momento.');
      room.game = null;
      return broadcast(room);
    }

    if (action === 'leave') {
      player.connected = false;
      player.ws = null;
      migrateHost(room);
      if (room.game && room.game.phase !== 'reveal') {
        addOfflineSubmissions(room);
        completeIfReady(room);
      }
      broadcast(room);
      try { ws.close(); } catch { /* ignore */ }
    }
  });

  ws.on('close', () => {
    const room = getRoom(ws);
    if (!room) return;
    const player = getPlayer(room, ws.playerId);
    if (!player || player.ws !== ws) return;
    player.connected = false;
    player.ws = null;
    migrateHost(room);
    if (room.game && room.game.phase !== 'reveal') {
      addOfflineSubmissions(room);
      completeIfReady(room);
    }
    broadcast(room);
    if (room.players.every(p => !p.connected) && !room.game) {
      setTimeout(() => { if (rooms.get(room.code) === room && room.players.every(p => !p.connected)) rooms.delete(room.code); }, 30 * 60 * 1000);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Scarabocchio Party è online sulla porta ${PORT}`);
});
