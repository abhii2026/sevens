'use strict';
// Sevens – internet multiplayer. Rooms + share links. `node server.js` or any Node host.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const GRACE = +process.env.GRACE_MS || 30000, DEBOUNCE = +process.env.DEBOUNCE_MS || 1500; // 30s reconnect grace window
const JOIN_WAIT = +process.env.JOIN_WAIT_MS || 20000;
const PORT = +process.env.PORT || 3000, MAX = 12, MAX_ROOMS = 80, H7 = 19; // card id = suit*13 + rank-1 ; 7♥ = 19
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
const RK = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'], SY = ['♠', '♥', '♦', '♣'];
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'));
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'"
};

const rooms = new Map(); // code -> table
const byToken = new Map(); // token -> { S, p }
const conns = new Map(); // token -> Set(res)
const rateMap = new Map(); // ip -> { count, resetAt }

const cardName = id => RK[id % 13 + 1] + SY[id / 13 | 0];
const cardPts = id => (id % 13) + 1; // A=1, 2..10=2..10, J=11, Q=12, K=13
const handPts = hand => hand.reduce((sum, id) => sum + cardPts(id), 0);
const active = p => !p.spectator && !p.done;
const hostId = S => { const h = S.players.find(p => p.on) || S.players[0]; return h ? h.id : null; };
const normRoom = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

function checkRate(req, max = 80, windowMs = 10000) {
  const ip = req.socket.remoteAddress || 'local';
  const now = Date.now();
  let rec = rateMap.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + windowMs };
    rateMap.set(ip, rec);
  }
  return ++rec.count <= max;
}

function newCode() {
  let c;
  do c = Array.from({ length: 4 }, () => ABC[crypto.randomInt(ABC.length)]).join('');
  while (rooms.has(c));
  return c;
}
function makeRoom(code) {
  return { code, phase: 'lobby', round: 0, players: [], board: [null, null, null, null], turn: -1, log: [], last: -1, places: 0, started: false, nid: 1, timer: null, idle: null, chat: [], chatSeq: 0, alert: null, endAlerted: false };
}
function shareUrl(S) { return PUBLIC_ORIGIN ? PUBLIC_ORIGIN + '/?r=' + S.code : ''; }

function canPlay(S, id) {
  if (!S.started) return id === H7;
  const s = id / 13 | 0, r = id % 13 + 1, b = S.board[s];
  return b ? (r === b[0] - 1 || r === b[1] + 1) : r === 7;
}
const legal = (S, p) => (p && p.hand ? p.hand.filter(id => canPlay(S, id)) : []);

function findWaitingPlayer(S) {
  if (S.phase !== 'playing') return null;
  const cur = S.turn >= 0 ? S.players[S.turn] : null;
  if (cur && !cur.on && !cur.bot && cur.deadline > Date.now()) return cur;
  return S.players.find(q => active(q) && !q.on && !q.bot && q.deadline > Date.now()) || null;
}

function view(S, p) {
  const cur = S.turn >= 0 ? S.players[S.turn] : null;
  const wp = findWaitingPlayer(S);
  const wait = wp ? { name: wp.name, left: Math.max(0, Math.ceil((wp.deadline - Date.now()) / 1000)) } : null;
  return {
    phase: S.phase, round: S.round || 0, you: p.id, host: hostId(S), max: MAX, room: S.code, url: shareUrl(S),
    players: S.players.map(q => ({
      id: q.id, name: q.name, n: q.hand.length, on: q.on, bot: !!q.bot,
      place: q.place, spec: q.spectator,
      score: q.score || 0,
      roundPts: q.roundPts || 0,
      leftCards: S.phase === 'over' ? (q.leftCards || []) : []
    })),
    board: S.board, turn: cur ? cur.id : null, hand: p.hand, legal: cur === p ? legal(S, p) : [],
    last: S.last, log: S.log.slice(-5), spec: p.spectator, place: p.place,
    chat: S.chat.slice(-40), alert: S.alert, wait
  };
}

function push(S) {
  clearTimeout(S.timer);
  if (S.phase === 'playing' && S.players.length) {
    if (S.turn < 0 || S.turn >= S.players.length || !active(S.players[S.turn])) {
      advance(S);
    }
  }
  for (const p of S.players) {
    const payload = 'data: ' + JSON.stringify(view(S, p)) + '\n\n';
    for (const res of conns.get(p.t) || []) {
      try { res.write(payload); } catch (e) {}
    }
  }
  if (S.phase !== 'playing' || !S.players.some(x => x.on)) return; // nobody connected: freeze the table
  const p = S.players[S.turn];
  if (!p) return;
  if (!p.on && !p.bot) return;
  const l = legal(S, p);
  if (!l.length) {
    S.timer = setTimeout(() => {
      if (S.phase !== 'playing' || S.players[S.turn] !== p) return;
      addLog(S, p.name + ' has no move and passes');
      recordPass(S, p);
      afterMove(S);
    }, 1200);
  } else if (!p.on && p.bot) {
    S.timer = setTimeout(() => {
      if (S.phase !== 'playing' || S.players[S.turn] !== p || p.on || !p.bot) return;
      const curLegal = legal(S, p);
      if (curLegal.length) play(S, p, botMove(S, p, curLegal));
    }, 1000);
  }
}

function addLog(S, t) { S.log.push(t); if (S.log.length > 30) S.log.shift(); }
function addChat(S, name, text, sys, kind = '') {
  S.chat.push({ id: ++S.chatSeq, name: name || '', text, sys: !!sys, kind });
  if (S.chat.length > 80) S.chat.splice(0, S.chat.length - 80);
}
function notify(S, msg, kind = '') { addChat(S, '', msg, true, kind); S.alert = { id: S.chatSeq, msg }; }

// ============ Bot: Traps opponents with high-point cards (8..K) while shedding its own heavy cards ============
const BOT_MS = +process.env.BOT_MS || 50;
const OWN = Array.from({ length: Math.max(16, MAX + 4) }, () => new Uint8Array(52)), TMP = [];

function evalMove(id, own, lo, hi) {
  const s = (id / 13) | 0, r = id - s * 13 + 1, base = s * 13;
  let myAbovePts = 0, oppAbovePts = 0, myBelowPts = 0, oppBelowPts = 0;
  for (let rk = r + 1; rk <= 13; rk++) {
    if (own[base + rk - 1]) myAbovePts += rk;
    else oppAbovePts += rk;
  }
  for (let rk = 1; rk < r; rk++) {
    if (own[base + rk - 1]) myBelowPts += rk;
    else oppBelowPts += rk;
  }

  let sc = 0;
  if (r === 7) {
    sc += 0.55 * (myAbovePts + myBelowPts) - 0.45 * oppAbovePts - 0.15 * oppBelowPts - 4;
    if (own[id - 1]) sc += 2.5;
    if (own[id + 1]) sc += 3.5;
  } else if (r > 7) {
    sc += r * 0.45 + 0.65 * myAbovePts - 0.55 * oppAbovePts;
    if (r < 13 && own[id + 1]) sc += 4;
    if (oppAbovePts === 0) sc += 6;
  } else {
    sc += r * 0.25 + 0.5 * myBelowPts - 0.18 * oppBelowPts + 1.5;
    if (r > 1 && own[id - 1]) sc += 3;
    if (oppBelowPts === 0) sc += 4;
  }
  return sc;
}

function heurPick(h, own, lo, hi, eps) {
  TMP.length = 0;
  for (let i = 0; i < h.length; i++) {
    const id = h[i], s = (id / 13) | 0, r = id - s * 13 + 1;
    if (lo[s] === 0 ? r === 7 : (r === lo[s] - 1 || r === hi[s] + 1)) TMP.push(id);
  }
  if (!TMP.length) return -1;
  if (TMP.length === 1) return TMP[0];
  if (eps && Math.random() < eps) return TMP[(Math.random() * TMP.length) | 0];
  let best = TMP[0], bs = -1e9;
  for (let i = 0; i < TMP.length; i++) {
    const id = TMP[i];
    const sc = evalMove(id, own, lo, hi) + Math.random() * 0.15;
    if (sc > bs) { bs = sc; best = id; }
  }
  return best;
}

function applyCard(lo, hi, id) {
  const s = (id / 13) | 0, r = id - s * 13 + 1;
  if (lo[s] === 0) lo[s] = hi[s] = r; else if (r < lo[s]) lo[s] = r; else hi[s] = r;
}

function scoreRolloutOutcome(hands, me) {
  const myPts = handPts(hands[me]);
  let oppTotal = 0, oppMax = 0, oppCount = 0;
  for (let i = 0; i < hands.length; i++) {
    if (i === me) continue;
    const pts = handPts(hands[i]);
    oppTotal += pts;
    if (pts > oppMax) oppMax = pts;
    oppCount++;
  }
  const avgOpp = oppCount ? oppTotal / oppCount : 0;
  if (myPts === 0) return 1.0 + 0.008 * avgOpp + 0.004 * oppMax;
  return Math.max(0.05, 0.65 + 0.006 * (avgOpp - myPts));
}

function rollout(hands, lo, hi, me, m0, eps) {
  const n = hands.length;
  if (!hands[me].length) return scoreRolloutOutcome(hands, me);
  let activeCount = 0;
  for (let i = 0; i < n; i++) {
    const h = hands[i];
    if (!OWN[i]) OWN[i] = new Uint8Array(52);
    const o = OWN[i];
    o.fill(0);
    for (let j = 0; j < h.length; j++) o[h[j]] = 1;
    if (h.length) activeCount++;
  }
  let idle = 0, turn = (me + 1) % n;
  for (let step = 0; step < 400; step++) {
    const h = hands[turn];
    if (h.length) {
      const id = heurPick(h, OWN[turn], lo, hi, turn === me ? 0 : eps);
      if (id < 0) {
        if (++idle >= activeCount) return scoreRolloutOutcome(hands, me);
      } else {
        idle = 0;
        const j = h.indexOf(id); h[j] = h[h.length - 1]; h.pop();
        OWN[turn][id] = 0; applyCard(lo, hi, id);
        if (!h.length) return scoreRolloutOutcome(hands, me);
      }
    }
    turn = turn + 1 === n ? 0 : turn + 1;
  }
  return scoreRolloutOutcome(hands, me);
}

function sampleHands(unseen, seats, me, myHand) {
  const n = seats.length, opp = [];
  for (let i = 0; i < n; i++) if (i !== me && seats[i].n > 0) opp.push(i);
  if (opp.reduce((a, i) => a + seats[i].n, 0) !== unseen.length) return null;
  const elig = {}; for (const c of unseen) elig[c] = opp.filter(i => !seats[i].void.has(c)).length;
  for (let attempt = 0; attempt < 25; attempt++) {
    const cap = opp.map(i => seats[i].n), out = seats.map(() => []), cards = unseen.slice();
    for (let i = cards.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [cards[i], cards[j]] = [cards[j], cards[i]]; }
    cards.sort((a, b) => elig[a] - elig[b]);
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
      vals[m] += rollout(hands, l2, h2, me, m0, 0.08);
    }
    samples++;
    if (samples >= 4000 || (samples >= 10 && Date.now() - t0 >= budget)) break;
  }
  let bi = 0; for (let m = 1; m < moves.length; m++) if (vals[m] > vals[bi]) bi = m;
  return moves[bi];
}
function heurChoose(hand, board) {
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
function recordPass(S, p) {
  if (!p.void) p.void = new Set();
  for (let id = 0; id < 52; id++) if (canPlay(S, id)) p.void.add(id);
}

function advance(S) {
  const n = S.players.length;
  if (!n) { S.turn = -1; return; }
  const startIdx = S.turn >= 0 && S.turn < n ? S.turn : 0;
  for (let i = 1; i <= n; i++) {
    const j = (startIdx + i) % n;
    if (active(S.players[j])) { S.turn = j; return; }
  }
}

function finishRound(S, winner) {
  clearTimeout(S.timer);
  S.phase = 'over';
  S.turn = -1;
  const remaining = S.players.filter(q => !q.spectator && !q.done);
  remaining.sort((a, b) => handPts(a.hand) - handPts(b.hand) || a.hand.length - b.hand.length);
  for (const q of remaining) {
    q.done = true;
    q.place = ++S.places;
  }
  const summary = [];
  for (const q of S.players) {
    if (q.spectator) { q.roundPts = 0; q.leftCards = []; continue; }
    q.roundPts = handPts(q.hand);
    q.leftCards = q.hand.slice();
    q.score = (q.score || 0) + q.roundPts;
    if (q.roundPts > 0) summary.push(q.name + ' +' + q.roundPts + ' pts');
  }
  const prefix = winner ? (winner.name + ' went out first! ') : 'Round ended (board locked). ';
  addLog(S, prefix + (summary.length ? summary.join(', ') : '0 pts added'));
}

function afterMove(S) {
  if (S.phase === 'over') { push(S); return; }
  const left = S.players.filter(active);
  if (!left.length) {
    finishRound(S, null);
  } else {
    advance(S);
    if (S.players.filter(active).every(q => !legal(S, q).length)) {
      finishRound(S, null);
    }
  }
  push(S);
}

function play(S, p, id) {
  const idx = p.hand.indexOf(id);
  if (idx < 0) return;
  p.hand.splice(idx, 1);
  const s = id / 13 | 0, r = id % 13 + 1, b = S.board[s];
  if (!b) S.board[s] = [r, r]; else if (r < b[0]) b[0] = r; else b[1] = r;
  S.started = true; S.last = id; addLog(S, p.name + ' played ' + cardName(id));
  if (!p.hand.length) {
    p.done = true;
    p.place = ++S.places;
    finishRound(S, p);
    push(S);
    return;
  }
  afterMove(S);
}

function start(S) {
  for (const p of [...S.players]) if (!p.on) forgetPlayer(S, p);
  const n = S.players.length;
  if (n < 2) { push(S); return { err: 'At least 2 connected players are needed' }; }
  const deck = [...Array(52).keys()];
  for (let i = 51; i > 0; i--) { const j = crypto.randomInt(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  S.round = (S.round || 0) + 1;
  S.players.forEach(p => {
    p.hand = []; p.done = false; p.place = 0; p.spectator = false;
    p.bot = false; p.left = false; p.deadline = 0; p.void = new Set();
    p.score = p.score || 0; p.roundPts = 0; p.leftCards = [];
  });
  deck.forEach((c, i) => S.players[i % n].hand.push(c));
  S.players.forEach(p => p.hand.sort((a, b) => a - b));
  S.board = [null, null, null, null]; S.started = false; S.places = 0; S.last = -1; S.log = [];
  S.alert = null; S.endAlerted = false;
  S.turn = S.players.findIndex(p => p.hand.includes(H7)); S.phase = 'playing';
  addLog(S, 'Round ' + S.round + ' dealt to ' + n + ' players. ' + S.players[S.turn].name + ' holds the 7♥ and starts');
  push(S); return {};
}

// Safely removes a player from S.players while preserving S.turn index integrity!
function forgetPlayer(S, p) {
  clearTimeout(p.dtimer); clearTimeout(p.btimer);
  const curTurnP = S.turn >= 0 && S.turn < S.players.length ? S.players[S.turn] : null;
  const oldIdx = S.players.indexOf(p);
  S.players = S.players.filter(x => x !== p);
  if (S.phase === 'playing' && S.players.length) {
    if (curTurnP && curTurnP !== p) {
      S.turn = S.players.indexOf(curTurnP);
    } else if (oldIdx >= 0) {
      S.turn = (oldIdx - 1 + S.players.length) % S.players.length;
      advance(S);
    }
  }
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
  // When all participants have left the game (or nobody has ever connected and everyone left), close the room immediately
  if (!S.players.length || S.players.every(x => x.left || !x.joinedOnce)) {
    if (S.players.every(x => x.left) || !S.players.length) {
      dropRoom(S);
      return;
    }
  }
  // If all connected participants dropped without clicking leave, close after GRACE (30s)
  S.idle = setTimeout(() => { if (!S.players.some(x => x.on)) dropRoom(S); }, GRACE);
}

function join(b) {
  const want = normRoom(b.room);
  const rec = b.t ? byToken.get(String(b.t)) : null;
  if (rec && (!want || rec.S.code === want)) return { t: rec.p.t, room: rec.S.code, name: rec.p.name };
  let S;
  if (want) {
    S = rooms.get(want);
    if (!S) return { err: 'No table with that code. Check the link, or leave the code blank to start a new table.' };
  } else {
    if (rooms.size >= MAX_ROOMS) return { err: 'Too many tables right now. Try again in a minute.' };
    S = makeRoom(newCode());
    rooms.set(S.code, S);
  }
  const rawName = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 14);
  const base = rawName || 'Player';
  let ex = S.players.find(x => !x.on && x.name.toLowerCase() === base.toLowerCase());
  if (!ex && S.phase === 'playing') {
    const droppedActive = S.players.filter(x => !x.on && !x.spectator);
    if (droppedActive.length === 1 && (!rawName || droppedActive[0].name.toLowerCase().startsWith(base.toLowerCase()))) {
      ex = droppedActive[0];
    }
  }
  if (ex) {
    clearTimeout(ex.dtimer); clearTimeout(ex.btimer);
    const oldT = ex.t;
    byToken.delete(oldT);
    for (const r of conns.get(oldT) || []) try { r.end(); } catch (e) {}
    conns.delete(oldT);
    ex.t = crypto.randomBytes(16).toString('hex');
    ex.left = false;
    ex.bot = false;
    ex.deadline = 0;
    ex.rejoining = true;
    byToken.set(ex.t, { S, p: ex });
    ex.dtimer = setTimeout(() => {
      if (!ex.on && rooms.get(S.code) === S && S.phase === 'playing') {
        ex.bot = true; ex.deadline = 0; push(S);
      }
    }, JOIN_WAIT);
    return { t: ex.t, room: S.code, name: ex.name };
  }
  if (S.players.length >= MAX) return { err: 'The table is full (' + MAX + ' players)' };
  let nm = base, k = 2;
  while (S.players.some(x => x.name.toLowerCase() === nm.toLowerCase())) nm = (base.slice(0, 11).trim() + ' ' + k++);
  const p = { id: S.nid++, t: crypto.randomBytes(16).toString('hex'), name: nm, hand: [], on: false, done: false, place: 0, score: 0, roundPts: 0, leftCards: [], spectator: S.phase === 'playing', joinedOnce: false };
  S.players.push(p);
  byToken.set(p.t, { S, p });
  p.dtimer = setTimeout(() => {
    if (!p.on && rooms.get(S.code) === S && (S.phase !== 'playing' || p.spectator)) {
      forgetPlayer(S, p);
      if (S.players.length) push(S);
      scheduleIdle(S);
    }
  }, JOIN_WAIT);
  scheduleIdle(S);
  push(S);
  return { t: p.t, room: S.code, name: p.name };
}

function act(b) {
  if (!b || typeof b !== 'object') return { err: 'Bad request' };
  if (b.a === 'join') return join(b);
  const rec = b.t ? byToken.get(String(b.t)) : null;
  if (!rec) return { err: 'Not joined' };
  const { S, p } = rec;
  if (b.a !== 'leave' && (!p.on || p.bot)) {
    p.on = true; p.bot = false; p.left = false; p.deadline = 0;
    clearTimeout(p.dtimer); clearTimeout(p.btimer);
  }
  if (b.a === 'start') {
    if (p.id !== hostId(S)) return { err: 'Only the host can deal', state: view(S, p) };
    if (S.phase === 'playing') return { err: 'A round is in progress', state: view(S, p) };
    const r = start(S);
    return { ...r, state: view(S, p) };
  }
  if (b.a === 'resetscores') {
    if (p.id !== hostId(S)) return { err: 'Only the host can reset scores', state: view(S, p) };
    if (S.phase === 'playing') return { err: 'Cannot reset during an active round', state: view(S, p) };
    S.round = 0;
    S.players.forEach(q => { q.score = 0; q.roundPts = 0; q.leftCards = []; });
    notify(S, 'The host reset all table scores to 0.');
    push(S); return { state: view(S, p) };
  }
  if (b.a === 'play') {
    const cid = Number.isInteger(b.id) ? b.id : -1;
    if (S.phase !== 'playing' || S.players[S.turn] !== p) return { err: 'Not your turn', state: view(S, p) };
    if (!p.hand.includes(cid) || !canPlay(S, cid)) return { err: 'That card cannot be played', state: view(S, p) };
    play(S, p, cid); return { state: view(S, p) };
  }
  if (b.a === 'skipwait') {
    if (p.id !== hostId(S)) return { err: 'Only the host can do that', state: view(S, p) };
    const wp = findWaitingPlayer(S);
    if (!wp) return { err: 'Nobody to skip', state: view(S, p) };
    clearTimeout(wp.dtimer); clearTimeout(wp.btimer);
    wp.bot = true; wp.deadline = 0;
    notify(S, 'The host stopped waiting. A bot is playing for ' + wp.name + '.', 'leave');
    push(S); return { state: view(S, p) };
  }
  if (b.a === 'leave') {
    // If no other connected human players remain in the room, drop the room immediately!
    const othersOnline = S.players.some(x => x !== p && x.on && !x.left);
    if (!othersOnline) {
      dropRoom(S);
      return {};
    }
    if (S.phase === 'playing' && !p.spectator && !p.done) {
      p.left = true; p.bot = false; p.on = false; p.deadline = Date.now() + GRACE; p.announced = true;
      clearTimeout(p.dtimer); clearTimeout(p.btimer);
      for (const r of conns.get(p.t) || []) try { r.end(); } catch (e) {}
      conns.delete(p.t);
      notify(S, p.name + ' left the game. Waiting ' + Math.round(GRACE / 1000) + 's before a bot plays their cards.', 'leave');
      p.btimer = setTimeout(() => {
        if (p.on || !rooms.has(S.code)) return;
        p.bot = true; p.deadline = 0;
        notify(S, p.name + ' didn\u2019t return in ' + Math.round(GRACE / 1000) + 's — a bot is playing their cards.', 'leave');
        push(S);
      }, GRACE);
    } else {
      notify(S, p.name + ' left the table.', 'leave');
      forgetPlayer(S, p);
    }
    scheduleIdle(S);
    if (rooms.has(S.code) && S.players.length) push(S);
    return {};
  }
  if (b.a === 'chat') {
    const text = String(b.msg || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!text) return { err: 'Type a message first', state: view(S, p) };
    const now = Date.now();
    if (p.chatAt && now - p.chatAt < 400) return { err: 'Wait a moment before sending again', state: view(S, p) };
    p.chatAt = now;
    addChat(S, p.name, text, false); push(S); return { state: view(S, p) };
  }
  return { err: 'Unknown action' };
}

function createAppServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(INDEX_HTML);
    }
    if (req.method === 'GET' && u.pathname === '/health') {
      res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (req.method === 'GET' && u.pathname === '/events') {
      if (!checkRate(req, 80, 10000)) { res.writeHead(429, SEC_HEADERS); return res.end(); }
      const token = u.searchParams.get('t') || '';
      const rec = byToken.get(token);
      if (!rec) { res.writeHead(404, SEC_HEADERS); return res.end(); }
      const { S, p } = rec;
      res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 1500\n\n');
      if (!conns.has(p.t)) conns.set(p.t, new Set());
      conns.get(p.t).add(res);
      const was = !p.on;
      p.on = true; p.left = false; p.bot = false; p.deadline = 0;
      clearTimeout(S.idle); clearTimeout(p.dtimer); clearTimeout(p.btimer);
      if (!p.joinedOnce) {
        p.joinedOnce = true;
        addChat(S, '', p.name + ' joined the table.', true, 'join');
      } else if (was && (p.announced || p.rejoining)) {
        p.announced = false;
        p.rejoining = false;
        notify(S, p.name + ' rejoined the game' + (S.phase === 'playing' && p.hand.length ? ' (' + p.hand.length + ' cards)' : '') + '.', 'join');
      }
      res.on('close', () => {
        const set = conns.get(token); if (set) set.delete(res);
        if (set && set.size) return;
        const cur = byToken.get(token); if (!cur || cur.p !== p || p.left) return;
        p.on = false;
        if (S.phase !== 'playing') {
          p.dtimer = setTimeout(() => {
            if (!p.on && S.phase !== 'playing' && rooms.get(S.code) === S) {
              addChat(S, '', p.name + ' left the table.', true, 'leave');
              forgetPlayer(S, p);
              if (S.players.length) push(S);
              scheduleIdle(S);
            }
          }, 20000);
        } else if (!p.spectator && !p.done) {
          p.deadline = Date.now() + GRACE;
          p.dtimer = setTimeout(() => {
            if (p.on || p.left || p.bot) return;
            p.announced = true;
            notify(S, p.name + ' lost connection. Waiting ' + Math.round(GRACE / 1000) + 's for them to come back.', 'leave');
            push(S);
          }, DEBOUNCE);
          p.btimer = setTimeout(() => {
            if (p.on || !rooms.has(S.code)) return;
            p.bot = true; p.deadline = 0;
            notify(S, p.name + ' didn\u2019t return in ' + Math.round(GRACE / 1000) + 's — a bot is playing their cards. They can still rejoin.', 'leave');
            push(S);
          }, GRACE);
        }
        scheduleIdle(S);
        if (rooms.get(S.code) === S) push(S);
      });
      return push(S);
    }
    if (req.method === 'POST' && u.pathname === '/api') {
      if (!checkRate(req, 60, 10000)) {
        res.writeHead(429, { ...SEC_HEADERS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ err: 'Too many requests. Please slow down.' }));
      }
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json')) {
        res.writeHead(415, { ...SEC_HEADERS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ err: 'Expected application/json' }));
      }
      const origin = req.headers.origin;
      if (origin && req.headers.host) {
        try {
          if (new URL(origin).host !== req.headers.host) {
            res.writeHead(403, { ...SEC_HEADERS, 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ err: 'Cross-origin request blocked' }));
          }
        } catch (e) {
          res.writeHead(400, { ...SEC_HEADERS, 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ err: 'Invalid origin' }));
        }
      }
      let body = '', aborted = false;
      req.on('data', c => {
        body += c;
        if (body.length > 2000) { aborted = true; req.destroy(); }
      });
      req.on('end', () => {
        if (aborted) return;
        let out;
        try { out = act(JSON.parse(body)); } catch (e) { out = { err: 'Bad request' }; }
        res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    res.writeHead(404, SEC_HEADERS); res.end();
  });
}

if (require.main === module) {
  createAppServer().listen(PORT, '0.0.0.0', () => {
    console.log('\n  SEVENS is on the internet. Open:\n');
    console.log('    http://localhost:' + PORT);
    console.log('\n  Share the table link shown in the lobby (/?r=CODE). Empty rooms close after 1 minute.\n');
  });
  setInterval(() => {
    for (const set of conns.values()) for (const r of set) r.write(': hb\n\n');
    const now = Date.now();
    for (const [ip, rec] of rateMap) if (now > rec.resetAt) rateMap.delete(ip);
  }, 15000);
}

module.exports = { botChoose, heurChoose, evalMove, cardPts, handPts, createAppServer, rooms, byToken, GRACE };