'use strict';
// Sevens – internet multiplayer. Rooms + share links. `node server.js` or any Node host.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 3000, MAX = 12, MAX_ROOMS = 80, H7 = 19; // card id = suit*13 + rank-1 ; 7♥ = 19
const RK = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'], SY = ['♠', '♥', '♦', '♣'];
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map(); // code -> table
const byToken = new Map(); // token -> { S, p }
const conns = new Map(); // token -> Set(res)

const cardName = id => RK[id % 13 + 1] + SY[id / 13 | 0];
const active = p => !p.spectator && !p.done;
const hostId = S => { const h = S.players.find(p => p.on) || S.players[0]; return h ? h.id : null; };
const normRoom = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

function newCode() {
  let c;
  do c = Array.from({ length: 4 }, () => ABC[crypto.randomInt(ABC.length)]).join('');
  while (rooms.has(c));
  return c;
}
function makeRoom(code) {
  return { code, origin: '', phase: 'lobby', players: [], board: [null, null, null, null], turn: -1, log: [], last: -1, places: 0, started: false, nid: 1, timer: null, idle: null, chat: [], chatSeq: 0, alert: null, endAlerted: false };
}
function setOrigin(S, req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (host) S.origin = proto + '://' + host;
}
function shareUrl(S) { return (S.origin || '') + '/?r=' + S.code; }

function canPlay(S, id) {
  if (!S.started) return id === H7;
  const s = id / 13 | 0, r = id % 13 + 1, b = S.board[s];
  return b ? (r === b[0] - 1 || r === b[1] + 1) : r === 7;
}
const legal = (S, p) => p.hand.filter(id => canPlay(S, id));

function view(S, p) {
  const cur = S.turn >= 0 ? S.players[S.turn] : null;
  return {
    phase: S.phase, you: p.id, host: hostId(S), max: MAX, room: S.code, url: shareUrl(S),
    players: S.players.map(q => ({ id: q.id, name: q.name, n: q.hand.length, on: q.on, place: q.place, spec: q.spectator })),
    board: S.board, turn: cur ? cur.id : null, hand: p.hand, legal: cur === p ? legal(S, p) : [],
    last: S.last, log: S.log.slice(-5), spec: p.spectator, place: p.place,
    chat: S.chat.slice(-40), alert: S.alert
  };
}
function push(S) {
  for (const p of S.players) for (const res of conns.get(p.t) || []) res.write('data: ' + JSON.stringify(view(S, p)) + '\n\n');
  clearTimeout(S.timer);
  if (S.phase !== 'playing') return;
  const p = S.players[S.turn], l = legal(S, p);
  if (!l.length) S.timer = setTimeout(() => { addLog(S, p.name + ' has no move and passes'); afterMove(S); }, 1500);
  else if (!p.on) S.timer = setTimeout(() => play(S, p, l[crypto.randomInt(l.length)]), 2500);
}
function addLog(S, t) { S.log.push(t); if (S.log.length > 30) S.log.shift(); }
function addChat(S, name, text, sys) {
  S.chat.push({ id: ++S.chatSeq, name: name || '', text, sys: !!sys });
  if (S.chat.length > 80) S.chat.splice(0, S.chat.length - 80);
}
function nextActiveTurn(st) {
  const n = st.players.length;
  for (let i = 1; i <= n; i++) {
    const j = (st.turn + i) % n, p = st.players[j];
    if (!p.spectator && !p.done) { st.turn = j; return true; }
  }
  return false;
}
function maybeForcedThree(S) {
  if (S.phase !== 'playing' || S.endAlerted) return;
  let left = 0;
  for (const p of S.players) if (active(p)) left += p.hand.length;
  if (left !== 3) return;
  const st = {
    started: S.started,
    board: S.board.map(b => b && b.slice()),
    turn: S.turn,
    players: S.players.map(p => ({ spectator: p.spectator, done: p.done, hand: p.hand.slice() }))
  };
  for (let step = 0; step < 3; step++) {
    const p = st.players[st.turn];
    const L = p.hand.filter(id => canPlay(st, id));
    if (L.length !== 1) return;
    const id = L[0];
    p.hand.splice(p.hand.indexOf(id), 1);
    const s = id / 13 | 0, r = id % 13 + 1, b = st.board[s];
    if (!b) st.board[s] = [r, r]; else if (r < b[0]) b[0] = r; else b[1] = r;
    st.started = true;
    if (!p.hand.length) p.done = true;
    if (step < 2 && !nextActiveTurn(st)) return;
  }
  S.endAlerted = true;
  S.alert = { id: S.chatSeq + 1, msg: 'The last 3 cards will be played in the next 3 turns.' };
  addChat(S, '', S.alert.msg, true);
}

function advance(S) {
  const n = S.players.length;
  for (let i = 1; i <= n; i++) { const j = (S.turn + i) % n; if (active(S.players[j])) { S.turn = j; return; } }
}
function afterMove(S) {
  const left = S.players.filter(active);
  if (left.length <= 1) {
    if (left.length) { left[0].done = true; left[0].place = ++S.places; }
    S.phase = 'over'; S.turn = -1; addLog(S, 'Round over');
  } else {
    advance(S);
    maybeForcedThree(S);
  }
  push(S);
}
function play(S, p, id) {
  p.hand.splice(p.hand.indexOf(id), 1);
  const s = id / 13 | 0, r = id % 13 + 1, b = S.board[s];
  if (!b) S.board[s] = [r, r]; else if (r < b[0]) b[0] = r; else b[1] = r;
  S.started = true; S.last = id; addLog(S, p.name + ' played ' + cardName(id));
  if (!p.hand.length) { p.done = true; p.place = ++S.places; addLog(S, p.name + ' is out – place #' + p.place); }
  afterMove(S);
}
function start(S) {
  S.players = S.players.filter(p => p.on);
  const n = S.players.length;
  if (n < 2) return { err: 'At least 2 players are needed' };
  const deck = [...Array(52).keys()];
  for (let i = 51; i > 0; i--) { const j = crypto.randomInt(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  S.players.forEach(p => { p.hand = []; p.done = false; p.place = 0; p.spectator = false; });
  deck.forEach((c, i) => S.players[i % n].hand.push(c));
  S.players.forEach(p => p.hand.sort((a, b) => a - b));
  S.board = [null, null, null, null]; S.started = false; S.places = 0; S.last = -1; S.log = [];
  S.alert = null; S.endAlerted = false;
  S.turn = S.players.findIndex(p => p.hand.includes(H7)); S.phase = 'playing';
  addLog(S, 'Dealt to ' + n + ' players. ' + S.players[S.turn].name + ' holds the 7♥ and starts');
  push(S); return {};
}

function forgetPlayer(S, p) {
  S.players = S.players.filter(x => x !== p);
  byToken.delete(p.t);
  for (const res of conns.get(p.t) || []) try { res.end(); } catch (e) {}
  conns.delete(p.t);
}
function dropRoom(S) {
  clearTimeout(S.timer); clearTimeout(S.idle);
  for (const p of [...S.players]) forgetPlayer(S, p);
  rooms.delete(S.code);
}
function scheduleIdle(S) {
  clearTimeout(S.idle);
  if (S.players.some(x => x.on)) return;
  S.idle = setTimeout(() => { if (!S.players.some(x => x.on)) dropRoom(S); }, 60000);
}

function join(b) {
  const want = normRoom(b.room);
  const rec = byToken.get(b.t);
  if (rec && (!want || rec.S.code === want)) return { t: rec.p.t, room: rec.S.code };
  let S;
  if (want) {
    S = rooms.get(want);
    if (!S) return { err: 'No table with that code. Check the link, or leave the code blank to start a new table.' };
  } else {
    if (rooms.size >= MAX_ROOMS) return { err: 'Too many tables right now. Try again in a minute.' };
    S = makeRoom(newCode());
    rooms.set(S.code, S);
  }
  if (S.players.length >= MAX) return { err: 'The table is full (' + MAX + ' players)' };
  const base = String(b.name || '').trim().slice(0, 14) || 'Player'; let nm = base, k = 2;
  while (S.players.some(x => x.name === nm)) nm = base + ' ' + k++;
  const p = { id: S.nid++, t: crypto.randomBytes(12).toString('hex'), name: nm, hand: [], on: false, done: false, place: 0, spectator: S.phase === 'playing' };
  S.players.push(p); byToken.set(p.t, { S, p }); push(S); return { t: p.t, room: S.code };
}

function act(b) {
  if (b.a === 'join') return join(b);
  const rec = byToken.get(b.t);
  if (!rec) return { err: 'Not joined' };
  const { S, p } = rec;
  if (b.a === 'start') {
    if (p.id !== hostId(S)) return { err: 'Only the host can deal' };
    if (S.phase === 'playing') return { err: 'A round is in progress' };
    return start(S);
  }
  if (b.a === 'play') {
    if (S.phase !== 'playing' || S.players[S.turn] !== p) return { err: 'Not your turn' };
    if (!p.hand.includes(b.id) || !canPlay(S, b.id)) return { err: 'That card cannot be played' };
    play(S, p, b.id); return {};
  }
  if (b.a === 'chat') {
    const text = String(b.msg || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!text) return { err: 'Type a message first' };
    const now = Date.now();
    if (p.chatAt && now - p.chatAt < 400) return { err: 'Wait a moment before sending again' };
    p.chatAt = now;
    addChat(S, p.name, text, false); push(S); return {};
  }
  return { err: 'Unknown action' };
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  if (req.method === 'GET' && u.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok');
  }
  if (req.method === 'GET' && u.pathname === '/events') {
    const rec = byToken.get(u.searchParams.get('t'));
    if (!rec) { res.writeHead(404); return res.end(); }
    const { S, p } = rec;
    setOrigin(S, req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 1500\n\n');
    if (!conns.has(p.t)) conns.set(p.t, new Set());
    conns.get(p.t).add(res); p.on = true; clearTimeout(S.idle);
    res.on('close', () => {
      const set = conns.get(p.t); if (set) set.delete(res);
      if (set && set.size) return;
      p.on = false;
      if (S.phase !== 'playing') setTimeout(() => {
        if (!p.on && S.phase !== 'playing' && rooms.get(S.code) === S) { forgetPlayer(S, p); if (S.players.length) push(S); }
      }, 20000);
      scheduleIdle(S);
      if (rooms.get(S.code) === S) push(S);
    });
    return push(S);
  }
  if (req.method === 'POST' && u.pathname === '/api') {
    let body = ''; req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      let out; try { out = act(JSON.parse(body)); } catch (e) { out = { err: 'Bad request' }; }
      if (out && out.room) {
        const rec = byToken.get(out.t);
        if (rec) setOrigin(rec.S, req);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, '0.0.0.0', () => {
  console.log('\n  SEVENS is on the internet. Open:\n');
  console.log('    http://localhost:' + PORT);
  console.log('\n  Share the table link shown in the lobby (/?r=CODE). Empty rooms close after 1 minute.\n');
});
setInterval(() => { for (const set of conns.values()) for (const r of set) r.write(': hb\n\n'); }, 15000);
