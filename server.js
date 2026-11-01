'use strict';
// Sevens – internet multiplayer. Rooms + share links. `node server.js` or any Node host.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const GRACE = +process.env.GRACE_MS || 90000, DEBOUNCE = +process.env.DEBOUNCE_MS || 8000; // how long a dropped player is waited for / when we announce it
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
  const wait = S.phase === 'playing' && cur && !cur.on && !cur.bot && cur.deadline && legal(S, cur).length
    ? { name: cur.name, left: Math.max(0, Math.ceil((cur.deadline - Date.now()) / 1000)) } : null;
  return {
    phase: S.phase, you: p.id, host: hostId(S), max: MAX, room: S.code, url: shareUrl(S),
    players: S.players.map(q => ({ id: q.id, name: q.name, n: q.hand.length, on: q.on, bot: !!q.bot, place: q.place, spec: q.spectator })),
    board: S.board, turn: cur ? cur.id : null, hand: p.hand, legal: cur === p ? legal(S, p) : [],
    last: S.last, log: S.log.slice(-5), spec: p.spectator, place: p.place,
    chat: S.chat.slice(-40), alert: S.alert, wait
  };
}
function push(S) {
  for (const p of S.players) for (const res of conns.get(p.t) || []) res.write('data: ' + JSON.stringify(view(S, p)) + '\n\n');
  clearTimeout(S.timer);
  if (S.phase !== 'playing' || !S.players.some(x => x.on)) return; // nobody connected: freeze the table
  const p = S.players[S.turn], l = legal(S, p);
  if (!l.length) S.timer = setTimeout(() => { addLog(S, p.name + ' has no move and passes'); recordPass(S, p); afterMove(S); }, 1500);
  else if (!p.on && p.bot) S.timer = setTimeout(() => play(S, p, botMove(S, p, l)), 1200); // grace over: a bot plays, but only for absent players
}
function addLog(S, t) { S.log.push(t); if (S.log.length > 30) S.log.shift(); }
function addChat(S, name, text, sys) {
  S.chat.push({ id: ++S.chatSeq, name: name || '', text, sys: !!sys });
  if (S.chat.length > 80) S.chat.splice(0, S.chat.length - 80);
}
function notify(S, msg) { addChat(S, '', msg, true); S.alert = { id: S.chatSeq, msg }; }
// ============ Bot: plays for absent players using only PUBLIC information ============
// It sees its own hand, the board, how many cards each seat holds and who has passed (a pass proves the player
// held none of the cards that were playable then). It samples possible hidden hands consistent with that, plays each
// candidate card out to the end of the round many times (determinized Monte-Carlo) and picks the card that wins most.
const BOT_MS = +process.env.BOT_MS || 150;
const OWN = Array.from({ length: 16 }, () => new Uint8Array(52)), TMP = [];
const reward = (k, m) => m < 2 ? 1 : (k === 1 ? 0.7 : 0) + 0.3 * (m - k) / (m - 1); // winning matters most, earlier finish still counts

// Fast rule of thumb used inside the simulations: avoid exposing a card the opponents might hold, dump cards that
// expose nothing (A, K, or ones whose follow-up I hold), keep 7s back because they open a suit for everyone.
function heurPick(h, own, lo, hi, eps) {
  TMP.length = 0;
  for (let i = 0; i < h.length; i++) {
    const id = h[i], s = (id / 13) | 0, r = id - s * 13 + 1;
    if (lo[s] === 0 ? r === 7 : (r === lo[s] - 1 || r === hi[s] + 1)) TMP.push(id);
  }
  if (!TMP.length) return -1;
  if (TMP.length === 1) return TMP[0];
  if (eps && Math.random() < eps) return TMP[(Math.random() * TMP.length) | 0];
  let best = -1, bs = -1e9;
  for (let i = 0; i < TMP.length; i++) {
    const id = TMP[i], s = (id / 13) | 0, r = id - s * 13 + 1;
    let sc = 0.15 * Math.abs(r - 7) + Math.random() * 0.2;
    if (lo[s] === 0) sc += (own[id - 1] ? 1 : -3) + (own[id + 1] ? 1 : -3) - 1;
    else if (r < lo[s]) sc += r > 1 ? (own[id - 1] ? 1 : -3) : 1.5;
    else sc += r < 13 ? (own[id + 1] ? 1 : -3) : 1.5;
    if (sc > bs) { bs = sc; best = id; }
  }
  return best;
}
function applyCard(lo, hi, id) {
  const s = (id / 13) | 0, r = id - s * 13 + 1;
  if (lo[s] === 0) lo[s] = hi[s] = r; else if (r < lo[s]) lo[s] = r; else hi[s] = r;
}
// One imagined game from a fully specified deal. Returns how good the outcome is for seat `me`.
function rollout(hands, lo, hi, me, m0, eps) {
  const n = hands.length;
  if (!hands[me].length) return reward(1, m0);
  let active = 0;
  for (let i = 0; i < n; i++) { const h = hands[i], o = OWN[i]; o.fill(0); for (let j = 0; j < h.length; j++) o[h[j]] = 1; if (h.length) active++; }
  let finished = 0, idle = 0, turn = (me + 1) % n;
  for (let step = 0; step < 800; step++) {
    const h = hands[turn];
    if (h.length) {
      const id = heurPick(h, OWN[turn], lo, hi, turn === me ? 0 : eps);
      if (id < 0) { if (++idle >= active) return 0.1; }
      else {
        idle = 0; const j = h.indexOf(id); h[j] = h[h.length - 1]; h.pop(); OWN[turn][id] = 0; applyCard(lo, hi, id);
        if (!h.length) { finished++; active--; if (turn === me) return reward(finished, m0); }
      }
    }
    turn = turn + 1 === n ? 0 : turn + 1;
  }
  return 0.1;
}
// Deal the unseen cards to opponents at random, never giving a player a card they proved (by passing) they don't hold.
function sampleHands(unseen, seats, me, myHand) {
  const n = seats.length, opp = [];
  for (let i = 0; i < n; i++) if (i !== me && seats[i].n > 0) opp.push(i);
  if (opp.reduce((a, i) => a + seats[i].n, 0) !== unseen.length) return null;
  const elig = {}; for (const c of unseen) elig[c] = opp.filter(i => !seats[i].void.has(c)).length;
  for (let attempt = 0; attempt < 25; attempt++) {
    const cap = opp.map(i => seats[i].n), out = seats.map(() => []), cards = unseen.slice();
    for (let i = cards.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [cards[i], cards[j]] = [cards[j], cards[i]]; }
    cards.sort((a, b) => elig[a] - elig[b]); // most constrained cards first
    let ok = true;
    for (const c of cards) {
      let tot = 0; for (let k = 0; k < opp.length; k++) if (cap[k] > 0 && !seats[opp[k]].void.has(c)) tot += cap[k];
      if (!tot) { ok = false; break; }
      let x = Math.random() * tot, pick = -1;
      for (let k = 0; k < opp.length; k++) if (cap[k] > 0 && !seats[opp[k]].void.has(c)) { x -= cap[k]; if (x < 0) { pick = k; break; } }
      out[opp[pick]].push(c); cap[pick]--;
    }
    if (ok) { out[me] = myHand.slice(); return out; }
  }
  return null;
}
function movesFor(hand, lo, hi) {
  return hand.filter(id => { const s = (id / 13) | 0, r = id - s * 13 + 1; return lo[s] === 0 ? r === 7 : (r === lo[s] - 1 || r === hi[s] + 1); });
}
function boardArrays(board) {
  const lo = new Int8Array(4), hi = new Int8Array(4);
  for (let s = 0; s < 4; s++) if (board[s]) { lo[s] = board[s][0]; hi[s] = board[s][1]; }
  return [lo, hi];
}
// o = { hand, board:[[lo,hi]|null x4], seats:[{n, void:Set}], me, budgetMs }
function botChoose(o) {
  const { hand, board, seats, me } = o, budget = o.budgetMs == null ? BOT_MS : o.budgetMs;
  const [lo, hi] = boardArrays(board), moves = movesFor(hand, lo, hi);
  if (moves.length <= 1) return moves[0];
  const seen = new Uint8Array(52); hand.forEach(id => { seen[id] = 1; });
  for (let s = 0; s < 4; s++) if (board[s]) for (let r = lo[s]; r <= hi[s]; r++) seen[s * 13 + r - 1] = 1;
  const unseen = []; for (let id = 0; id < 52; id++) if (!seen[id]) unseen.push(id);
  const m0 = seats.filter(x => x.n > 0).length, vals = new Float64Array(moves.length);
  let samples = 0; const t0 = Date.now();
  for (;;) {
    const base = sampleHands(unseen, seats, me, hand);
    if (!base) return heurChoose(hand, board);
    for (let m = 0; m < moves.length; m++) {
      const hands = base.map(h => h.slice()), h = hands[me], l2 = lo.slice(), h2 = hi.slice();
      h.splice(h.indexOf(moves[m]), 1); applyCard(l2, h2, moves[m]);
      vals[m] += rollout(hands, l2, h2, me, m0, 0.1);
    }
    samples++;
    if (samples >= 4000 || (samples >= 10 && Date.now() - t0 >= budget)) break;
  }
  let bi = 0; for (let m = 1; m < moves.length; m++) if (vals[m] > vals[bi]) bi = m;
  return moves[bi];
}
function heurChoose(hand, board) { // no search; used as a fallback and as a baseline
  const [lo, hi] = boardArrays(board), own = new Uint8Array(52); hand.forEach(id => { own[id] = 1; });
  return heurPick(hand, own, lo, hi, 0);
}
function botMove(S, p, l) {
  if (l.length === 1) return l[0];
  try {
    const seats = S.players.map(q => ({ n: active(q) ? q.hand.length : 0, void: q.void || new Set() }));
    const id = botChoose({ hand: p.hand, board: S.board, seats, me: S.players.indexOf(p) });
    return l.includes(id) ? id : l[crypto.randomInt(l.length)];
  } catch (e) { return l[crypto.randomInt(l.length)]; }
}
function recordPass(S, p) { // a pass proves the player holds none of the cards that were playable right now
  if (!p.void) p.void = new Set();
  for (let id = 0; id < 52; id++) if (canPlay(S, id)) p.void.add(id);
}

function maybeLastThree(S) {
  if (S.phase !== 'playing' || S.endAlerted) return;
  const holders = [];
  let left = 0;
  for (let i = 0; i < S.players.length; i++) {
    const p = S.players[(S.turn + i) % S.players.length];
    if (active(p) && p.hand.length) { left += p.hand.length; holders.push(p.name); }
  }
  if (left !== 3) return;
  S.endAlerted = true;
  S.alert = { id: S.chatSeq + 1, msg: 'Last three cards sure: ' + holders.join(' & ') };
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
    if (S.players.filter(active).every(q => !legal(S, q).length)) { // safety net: nobody can ever move again
      S.players.filter(active).sort((a, b) => a.hand.length - b.hand.length).forEach(q => { q.done = true; q.place = ++S.places; });
      S.phase = 'over'; S.turn = -1; addLog(S, 'Round over');
    } else maybeLastThree(S);
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
  S.players.forEach(p => { p.hand = []; p.done = false; p.place = 0; p.spectator = false; p.void = new Set(); });
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
  S.idle = setTimeout(() => { if (!S.players.some(x => x.on)) dropRoom(S); }, S.phase === 'playing' ? 300000 : 60000);
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
  const base = String(b.name || '').trim().slice(0, 14) || 'Player';
  const ex = S.players.find(x => !x.on && x.name.toLowerCase() === base.toLowerCase());
  if (ex) { // same name as a disconnected player: take the seat (and hand) back, e.g. after switching device
    byToken.delete(ex.t); ex.t = crypto.randomBytes(12).toString('hex'); ex.left = false; byToken.set(ex.t, { S, p: ex });
    return { t: ex.t, room: S.code };
  }
  if (S.players.length >= MAX) return { err: 'The table is full (' + MAX + ' players)' };
  let nm = base, k = 2;
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
  if (b.a === 'skipwait') {
    if (p.id !== hostId(S)) return { err: 'Only the host can do that' };
    const cur = S.phase === 'playing' ? S.players[S.turn] : null;
    if (!cur || cur.on || cur.bot) return { err: 'Nobody to skip' };
    clearTimeout(cur.btimer); cur.bot = true;
    notify(S, 'The host stopped waiting. A bot is playing for ' + cur.name + '.'); push(S); return {};
  }
  if (b.a === 'leave') {
    if (S.phase === 'playing' && !p.spectator && !p.done) {
      p.left = true; p.bot = true; p.on = false; p.announced = true; clearTimeout(p.dtimer); clearTimeout(p.btimer);
      for (const r of conns.get(p.t) || []) try { r.end(); } catch (e) {}
      conns.delete(p.t);
      notify(S, p.name + ' left the game. A bot will play their cards; they can rejoin with the same name.');
    } else { notify(S, p.name + ' left the table.'); forgetPlayer(S, p); }
    if (S.players.length) push(S);
    scheduleIdle(S); return {};
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
    conns.get(p.t).add(res);
    const was = !p.on; p.on = true; p.left = false; p.bot = false; p.deadline = 0;
    clearTimeout(S.idle); clearTimeout(p.dtimer); clearTimeout(p.btimer);
    if (was && p.announced) { p.announced = false; notify(S, p.name + ' is back' + (S.phase === 'playing' && p.hand.length ? ' with ' + p.hand.length + ' cards' : '') + '.'); }
    res.on('close', () => {
      const set = conns.get(p.t); if (set) set.delete(res);
      if (set && set.size) return;
      const cur = byToken.get(p.t); if (!cur || cur.p !== p || p.left) return;
      p.on = false;
      if (S.phase !== 'playing') setTimeout(() => {
        if (!p.on && S.phase !== 'playing' && rooms.get(S.code) === S) { forgetPlayer(S, p); if (S.players.length) push(S); }
      }, 20000);
      else if (!p.spectator && !p.done) {
        p.deadline = Date.now() + GRACE;
        p.dtimer = setTimeout(() => { // announce only if it's not just a brief screen-lock flicker
          if (p.on || p.left || p.bot) return;
          p.announced = true; notify(S, p.name + ' lost connection. Waiting up to ' + Math.round(GRACE / 1000) + ' seconds for them to come back.'); push(S);
        }, DEBOUNCE);
        p.btimer = setTimeout(() => {
          if (p.on || p.left) return;
          p.bot = true; if (p.announced) notify(S, p.name + ' didn\u2019t return, so a bot is playing their cards. They can still rejoin.');
          push(S);
        }, GRACE);
      }
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
module.exports = { botChoose, heurChoose }; // used by the offline strength test
