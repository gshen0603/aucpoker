// Auction Poker server: serves the web page and runs every table over WebSockets.
// The server is the only place the full deal and the sealed bids live, so no browser
// can see face-down cards or other players' bids before they are revealed.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const P = require('./public/game.js');
const { botBid } = require('./bots.js');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const LIMITS = { coins: [10, 1000], seconds: [10, 120], seats: [2, 4] };
const DEFAULTS = { startCoins: 100, bidSeconds: 30, maxSeats: 4, revealSeconds: 6 };
const BOT_LEVELS = ['easy', 'normal', 'hard'];
const BOT_NAMES = ['Ada', 'Blaise', 'Cardano', 'Durbin', 'Erdős', 'Fermat', 'Gauss', 'Huygens', 'Kelly', 'Nash', 'Thorp', 'Vickrey'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/healthz') { res.end('ok'); return; }
  if (p === '/' || !path.extname(p)) p = '/index.html';
  const file = path.join(PUB, path.normalize(p));
  if (!file.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- Rooms ----------
const rooms = new Map();
const clamp = (x, [lo, hi]) => Math.max(lo, Math.min(hi, Math.round(Number(x) || 0)));
const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 18) || 'Player';
const newId = () => crypto.randomBytes(6).toString('hex');

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c; do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms.has(c));
  return c;
}
function createRoom(clientId) {
  const room = { code: newCode(), hostClientId: clientId, settings: { ...DEFAULTS }, seats: [], conns: new Map(), kicked: new Set(), game: null, lastActive: Date.now(), hostTimer: null };
  rooms.set(room.code, room);
  return room;
}
const humanSeats = room => room.seats.filter(s => !s.bot);
const seatOf = (room, clientId) => room.seats.find(s => s.clientId === clientId);

function addHumanSeat(room, clientId, name) {
  if ((room.game && room.game.status !== 'showdown') || room.kicked.has(clientId) || room.seats.length >= room.settings.maxSeats) return null;
  const seat = { id: newId(), clientId, name: cleanName(name), bot: null };
  room.seats.push(seat);
  return seat;
}
function addBot(room, level) {
  if (room.seats.length >= room.settings.maxSeats) return;
  const used = new Set(room.seats.map(s => s.name));
  const base = BOT_NAMES.find(n => !used.has(n)) || `Bot ${room.seats.length + 1}`;
  room.seats.push({ id: newId(), clientId: null, name: base, bot: BOT_LEVELS.includes(level) ? level : 'normal' });
}

// ---------- Views (what each browser is allowed to see) ----------
function view(room, clientId) {
  const seat = seatOf(room, clientId);
  const v = {
    code: room.code,
    you: { clientId, seatId: seat ? seat.id : null, isHost: room.hostClientId === clientId, kicked: room.kicked.has(clientId) },
    settings: room.settings, limits: LIMITS, botLevels: BOT_LEVELS,
    seats: room.seats.map(s => ({ id: s.id, name: s.name, bot: s.bot, isHost: !!s.clientId && s.clientId === room.hostClientId, connected: s.bot ? true : room.conns.has(s.clientId) })),
    spectators: [...room.conns.keys()].filter(id => !seatOf(room, id)).length,
    game: null,
  };
  const g = room.game;
  if (g) {
    const reveal = g.status === 'showdown';
    v.game = {
      id: g.id, status: g.status, idx: g.idx, bidSeconds: g.bidSeconds,
      // Face-down cards are hidden from everyone except the player who bought that pile.
      piles: maskedPiles(g, reveal ? null : (seat ? seat.id : undefined), reveal),
      owners: g.owners, players: g.players,
      submitted: Object.keys(g.bids),
      myBid: seat && g.bids[seat.id] !== undefined ? g.bids[seat.id] : null,
      msLeft: g.status === 'bidding' ? Math.max(0, g.endsAt - Date.now()) : 0,
      nextIn: g.status === 'result' ? Math.max(0, g.nextAt - Date.now()) : 0,
      result: g.result,
    };
  }
  return v;
}
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room) { for (const [cid, ws] of room.conns) send(ws, { type: 'state', state: view(room, cid) }); }
function toast(ws, text) { send(ws, { type: 'error', text }); }

// ---------- Game flow ----------
function clearGameTimers(g) { if (!g) return; clearTimeout(g.roundTimer); clearTimeout(g.nextTimer); (g.botTimers || []).forEach(clearTimeout); g.botTimers = []; }

function startGame(room) {
  clearGameTimers(room.game);
  const { startCoins, bidSeconds } = room.settings;
  room.game = {
    id: newId(), status: 'bidding', idx: 0, bidSeconds,
    piles: P.dealPiles(room.seats.length), owners: [],
    players: room.seats.map(s => ({ seatId: s.id, name: s.name, bot: s.bot, coins: startCoins, won: 0, spent: 0 })),
    bids: {}, result: null, botTimers: [],
  };
  room.game.owners = room.game.piles.map(() => null);
  startRound(room);
}

// What one seat is allowed to see: face-up cards, plus the face-down cards in piles that seat owns.
function maskedPiles(g, seatId, revealAll = false) {
  return g.piles.map((p, i) => p.map(c => (revealAll || c.up || (seatId && g.owners[i] === seatId) ? c : { up: false })));
}

function startRound(room) {
  const g = room.game;
  g.status = 'bidding'; g.bids = {}; g.result = null;
  g.endsAt = Date.now() + g.bidSeconds * 1000;
  for (const p of g.players) if (p.coins <= 0) g.bids[p.seatId] = 0;
  g.roundTimer = setTimeout(() => resolveRound(room), g.bidSeconds * 1000);
  const maxDelay = Math.min(8000, g.bidSeconds * 400);
  for (const p of g.players) {
    if (!p.bot || p.coins <= 0) continue;
    const t = setTimeout(() => {
      if (g !== room.game || g.status !== 'bidding' || g.bids[p.seatId] !== undefined) return;
      g.bids[p.seatId] = botBid(p.bot, { me: p, players: g.players, piles: maskedPiles(g, p.seatId), owners: g.owners, idx: g.idx });
      afterBid(room);
    }, 1200 + Math.random() * (maxDelay - 1200));
    g.botTimers.push(t);
  }
  broadcast(room);
}

function afterBid(room) {
  const g = room.game;
  if (g.players.every(p => g.bids[p.seatId] !== undefined)) resolveRound(room);
  else broadcast(room);
}

function resolveRound(room) {
  const g = room.game;
  if (!g || g.status !== 'bidding') return;
  clearGameTimers(g);
  const bids = g.players.map(p => ({ pid: p.seatId, amt: g.bids[p.seatId] ?? 0 }));
  const r = P.resolveAuction(bids);
  if (r.winner !== null) {
    const w = g.players.find(p => p.seatId === r.winner);
    w.coins -= r.price; w.spent += r.price; w.won += 1;
    g.owners[g.idx] = r.winner;
  }
  g.result = { ...r, bids, timedOut: g.players.filter(p => g.bids[p.seatId] === undefined).map(p => p.seatId) };
  g.status = 'result';
  const ms = room.settings.revealSeconds * 1000;
  g.nextAt = Date.now() + ms;
  g.nextTimer = setTimeout(() => advance(room), ms);
  broadcast(room);
}

function advance(room) {
  const g = room.game;
  if (!g || g.status !== 'result') return;
  clearGameTimers(g);
  if (g.idx + 1 < g.piles.length) { g.idx += 1; startRound(room); }
  else { g.status = 'showdown'; broadcast(room); }
}

function ensureHost(room) {
  // If the host has been gone a while, hand the table to the next connected human.
  if (room.conns.has(room.hostClientId)) { clearTimeout(room.hostTimer); room.hostTimer = null; return; }
  if (room.hostTimer) return;
  room.hostTimer = setTimeout(() => {
    room.hostTimer = null;
    if (room.conns.has(room.hostClientId)) return;
    const next = humanSeats(room).find(s => room.conns.has(s.clientId)) || { clientId: [...room.conns.keys()][0] };
    if (next.clientId) { room.hostClientId = next.clientId; broadcast(room); }
  }, 20000);
}

// ---------- Messages ----------
const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let clientId = null, room = null;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'create' || m.type === 'join') {
      clientId = String(m.clientId || '').slice(0, 64) || newId();
      if (room) room.conns.delete(clientId);
      if (m.type === 'create') { room = createRoom(clientId); addHumanSeat(room, clientId, m.name); }
      else {
        room = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!room) { send(ws, { type: 'noroom' }); return; }
        const existing = seatOf(room, clientId);
        if (existing) { if (m.name && !room.game) existing.name = cleanName(m.name); }
        else addHumanSeat(room, clientId, m.name);
      }
      const old = room.conns.get(clientId);
      if (old && old !== ws) old.close(4000, 'Opened in another tab');
      room.conns.set(clientId, ws);
      room.lastActive = Date.now();
      send(ws, { type: 'joined', code: room.code, clientId });
      ensureHost(room);
      broadcast(room);
      return;
    }
    if (!room || !clientId) return;
    room.lastActive = Date.now();
    const isHost = room.hostClientId === clientId;
    const g = room.game;
    const seat = seatOf(room, clientId);
    const inLobby = !g || g.status === 'showdown';

    switch (m.type) {
      case 'settings': {
        if (!isHost || g && g.status !== 'showdown') return;
        const s = room.settings;
        if (m.startCoins !== undefined) s.startCoins = clamp(m.startCoins, LIMITS.coins);
        if (m.bidSeconds !== undefined) s.bidSeconds = clamp(m.bidSeconds, LIMITS.seconds);
        if (m.maxSeats !== undefined) s.maxSeats = Math.max(room.seats.length, clamp(m.maxSeats, LIMITS.seats));
        break;
      }
      case 'addBot': if (isHost && inLobby) addBot(room, m.level); break;
      case 'botLevel': {
        const s = room.seats.find(x => x.id === m.seatId);
        if (isHost && inLobby && s && s.bot && BOT_LEVELS.includes(m.level)) s.bot = m.level;
        break;
      }
      case 'removeSeat': {
        if (!isHost || !inLobby) return;
        const s = room.seats.find(x => x.id === m.seatId);
        if (!s || s.clientId === clientId) return;
        if (!s.bot) room.kicked.add(s.clientId);
        room.seats = room.seats.filter(x => x !== s);
        break;
      }
      case 'rename': if (seat && inLobby) seat.name = cleanName(m.name); break;
      case 'sit': if (!seat && inLobby) { if (!addHumanSeat(room, clientId, m.name)) toast(ws, room.kicked.has(clientId) ? 'The host removed you from this table.' : 'The table is full.'); } break;
      case 'stand': if (seat && inLobby) room.seats = room.seats.filter(x => x !== seat); break;
      case 'start':
        if (!isHost || !inLobby) return;
        if (room.seats.length < 2) { toast(ws, 'You need at least 2 seats filled (players or bots) to start.'); return; }
        startGame(room); return;
      case 'bid': {
        if (!g || g.status !== 'bidding' || !seat) return;
        const p = g.players.find(x => x.seatId === seat.id);
        if (!p || g.bids[seat.id] !== undefined) return;
        const n = Number(m.amt);
        if (!Number.isInteger(n) || n < 0 || n > p.coins) { toast(ws, `Bid a whole number from 0 to ${p.coins}.`); return; }
        g.bids[seat.id] = n;
        afterBid(room); return;
      }
      case 'next': if (isHost && g && g.status === 'result') advance(room); return;
      case 'lobby': if (isHost && g) { clearGameTimers(g); room.game = null; } break;
      default: return;
    }
    broadcast(room);
  });

  ws.on('close', () => {
    if (room && clientId && room.conns.get(clientId) === ws) { room.conns.delete(clientId); room.lastActive = Date.now(); ensureHost(room); broadcast(room); }
  });
});

// Keep connections alive behind proxies, and clean up abandoned tables.
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  const now = Date.now();
  for (const [code, room] of rooms) if (room.conns.size === 0 && now - room.lastActive > 30 * 60 * 1000) { clearGameTimers(room.game); rooms.delete(code); }
}, 25000);

server.listen(PORT, () => console.log(`Auction Poker running on http://localhost:${PORT}`));
