// Auction Poker browser client. All game decisions happen on the server;
// this file only renders the state it is sent and forwards your actions.
const { RANK_LABEL, RANK_ONE, SUIT_SYM, SUIT_NAME, CAT_NAME, score, cmp, bestFive, describe } = window.Poker;
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
let clientId = store.get('ap.clientId', null);
if (!clientId) { clientId = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)); store.set('ap.clientId', clientId); }

let ws = null, S = null, roomCode = null, screenKey = '', deadline = 0, nextDeadline = 0, retry = 0, pendingJoin = null, connected = false;

// ---------- Connection ----------
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => { connected = true; retry = 0; updateConn(); if (pendingJoin) ws.send(JSON.stringify(pendingJoin)); };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'joined') { roomCode = m.code; store.set('ap.room', m.code); history.replaceState(null, '', '?room=' + m.code); pendingJoin = { type: 'join', code: m.code, clientId }; }
    else if (m.type === 'noroom') { pendingJoin = null; roomCode = null; store.set('ap.room', ''); history.replaceState(null, '', location.pathname); S = null; renderHome("That table doesn't exist anymore. Check the code or start a new one."); }
    else if (m.type === 'error') toast(m.text);
    else if (m.type === 'state') {
      S = m.state;
      if (S.game) { deadline = Date.now() + S.game.msLeft; nextDeadline = Date.now() + S.game.nextIn; }
      render();
    }
  };
  ws.onclose = e => {
    connected = false; updateConn();
    if (e.code === 4000) { toast('This table is open in another tab.'); return; }
    setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
  };
}
function sendMsg(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); else toast('Reconnecting… try again in a moment.'); }
function joinRoom(type, extra) { pendingJoin = { type, clientId, name: store.get('ap.name', ''), ...extra }; sendMsg(pendingJoin); }
function updateConn() { const c = $('#conn'); if (c) { c.textContent = connected ? '' : 'Reconnecting…'; c.className = 'conn' + (connected ? '' : ' bad'); } }

let toastTimer;
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3500); }

// ---------- Helpers ----------
function mount(key, html) { if (screenKey !== key) { screenKey = key; $('#app').innerHTML = html; return true; } return false; }
function cardHTML(c, { small = false, hi = false, dim = false } = {}) {
  const cls = ['card', small ? 'sm' : '', hi ? 'hi' : '', dim ? 'dim' : ''].join(' ');
  if (!c.rank) return `<div class="${cls} back" aria-label="Face-down card"></div>`;
  const red = c.suit === 'h' || c.suit === 'd';
  // A face-down card we can still read is one you bought: only you see it until the showdown.
  const priv = !c.up && S && S.game && S.game.status !== 'showdown';
  return `<div class="${cls} ${red ? 'red' : ''} ${priv ? 'private' : ''}" aria-label="${RANK_ONE[c.rank]} of ${SUIT_NAME[c.suit]}${priv ? ', visible only to you' : ''}"${priv ? ' title="Only you can see this card"' : ''}><span class="r">${RANK_LABEL[c.rank]}</span><span class="s">${SUIT_SYM[c.suit]}</span></div>`;
}
const G = () => S.game;
const pl = id => G().players.find(p => p.seatId === id);
const cardsOf = id => G().piles.filter((_, i) => G().owners[i] === id).flat();
const pilesOf = id => G().piles.map((cards, i) => ({ i, cards })).filter(x => G().owners[x.i] === id);
// Cards laid out in rows of at most 5, so big piles wrap into tidy rows.
function pileGrid(cards, opts = {}) {
  return `<div class="pilegrid ${opts.small ? 'sm' : ''}" style="--cols:${Math.max(1, Math.min(5, cards.length))}">${cards.map(c => cardHTML(c, { small: opts.small, ...(opts.mark ? opts.mark(c) : {}) })).join('')}</div>`;
}
// A labeled, outlined box for one pile.
function pileBox(label, cards, opts = {}) {
  return `<div class="pilebox"><div class="pilebox-head"><strong>${label}</strong><span class="muted">${cards.length} card${cards.length === 1 ? '' : 's'}</span></div>${pileGrid(cards, opts)}</div>`;
}
function wonPiles(id, opts = {}) {
  const ps = pilesOf(id);
  return ps.length ? `<div class="pilerow">${ps.map(x => pileBox(`Pile ${x.i + 1}`, x.cards, { small: true, ...opts })).join('')}</div>` : '<span class="muted small">No piles won</span>';
}
function tags(p) {
  let t = '';
  if (p.bot) t += `<span class="tag">${esc(p.bot)} bot</span>`;
  if ((p.seatId || p.id) === S.you.seatId) t += '<span class="tag you">you</span>';
  return t;
}
function rulesHTML() {
  return `<details class="rules panel"><summary>How it plays</summary>
  <div class="rules-cols">
    <div><h3>Hand ranks, high to low</h3><ol>${[8, 7, 6, 5, 4, 3, 2, 1, 0].map(i => `<li>${CAT_NAME[i]}</li>`).join('')}</ol>
      <p>The only straights are 9 to K and 10 to A. A‑9‑10‑J‑Q is not a straight.</p></div>
    <div><h3>The deck and the deal</h3>
      <p>All 2s through 8s are removed, leaving 24 cards. They're split at random into piles: one more pile than there are players, up to 7 (so 3 to 7 piles with 2 players, 5 to 7 with 4), and each card lands face up or face down with even odds.</p>
      <p>The deal is redone until no straight flush or four of a kind shows among all face-up cards, and none sits inside any single pile.</p></div>
    <div><h3>Bidding</h3>
      <p>Everyone bids privately on each pile before the timer runs out. The highest bid wins and pays the second-highest bid. Tied top bids are broken at random; if nobody bids above zero, the pile is discarded. Bidding closes early once every bid is in.</p></div>
    <div><h3>Showdown</h3>
      <p>Face-down cards stay hidden from everyone, including their owner, until the showdown. Each player then makes their best five-card hand from all the cards they won. Leftover coins don't count.</p></div>
  </div></details>`;
}

// ---------- Home ----------
function renderHome(msg) {
  screenKey = 'home';
  const urlCode = new URLSearchParams(location.search).get('room') || '';
  $('#app').innerHTML = `<div class="wrap">
    <header class="hero">
      <div class="suits" aria-hidden="true">♠<span class="r">♥</span>♣<span class="r">♦</span></div>
      <h1>Auction Poker</h1>
      <p>Bid on piles of cards in sealed second-price auctions, then build the strongest five-card hand from everything you bought. Flushes outrank four of a kind.</p>
      <span id="conn" class="conn"></span>
    </header>
    ${msg ? `<p class="banner">${esc(msg)}</p>` : ''}
    <div class="panel field" style="max-width:420px"><label for="name">Your name</label><input id="name" maxlength="18" autocomplete="nickname" value="${esc(store.get('ap.name', ''))}" placeholder="What should the table call you?"></div>
    <div class="home-grid" style="margin-top:16px">
      <section class="panel"><h2>Join a table</h2>
        <div class="field"><label for="code">Table code</label>
        <div class="inline"><input id="code" class="code-input" maxlength="4" autocomplete="off" value="${esc(urlCode)}" placeholder="ABCD"><button class="primary" id="join">Join</button></div></div></section>
      <section class="panel"><h2>Start a table</h2><p class="muted" style="margin-bottom:12px">You'll host: pick the rules, add bots, and deal when everyone's in.</p>
        <button class="primary" id="create">Start a new table</button></section>
    </div>${rulesHTML()}</div>`;
  const saveName = () => { const n = $('#name').value.trim(); if (!n) { toast('Enter your name first.'); $('#name').focus(); return false; } store.set('ap.name', n); return true; };
  $('#create').onclick = () => { if (saveName()) joinRoom('create'); };
  $('#join').onclick = () => { const c = $('#code').value.trim().toUpperCase(); if (!saveName()) return; if (c.length !== 4) { toast('Table codes are 4 letters.'); return; } joinRoom('join', { code: c }); };
  $('#code').onkeydown = e => { if (e.key === 'Enter') $('#join').click(); };
  updateConn();
}

// ---------- Router ----------
function render() {
  if (!S) return;
  const g = S.game;
  if (!g) renderLobby();
  else if (g.status === 'showdown') renderShowdown();
  else renderGame();
  updateConn();
}

// ---------- Lobby ----------
function renderLobby() {
  const you = S.you, host = you.isHost, st = S.settings, lim = S.limits;
  mount('lobby-' + S.code, `<div class="wrap">
    <header class="bar"><h1>Auction Poker</h1><div class="bar-right"><span id="conn" class="conn"></span><button id="leave">Leave table</button></div></header>
    <section class="panel roomhead"><div><p class="muted small">Table code</p><div class="roomcode">${esc(S.code)}</div></div>
      <div class="inline"><button id="copy">Copy invite link</button></div></section>
    <section class="panel"><div class="sec-head"><h2>Seats</h2><span id="seatcount" class="muted"></span></div><div id="seats" class="seatrows"></div><div id="addbot"></div></section>
    <section class="panel"><h2>Table rules</h2><div id="settings"></div></section>
    <div class="actions" id="lobbyactions"></div>
    ${rulesHTML()}</div>`);
  $('#copy').onclick = async () => { const link = location.origin + location.pathname + '?room=' + S.code; try { await navigator.clipboard.writeText(link); toast('Invite link copied.'); } catch { prompt('Copy this link:', link); } };
  $('#leave').onclick = () => { if (you.seatId) sendMsg({ type: 'stand' }); store.set('ap.room', ''); pendingJoin = null; roomCode = null; S = null; history.replaceState(null, '', location.pathname); ws.close(); renderHome(); };

  $('#seatcount').textContent = `${S.seats.length} of ${st.maxSeats} filled${S.spectators ? `, ${S.spectators} watching` : ''}`;
  $('#seats').innerHTML = S.seats.map(s => `<div class="seatrow ${s.connected ? '' : 'off'}">
      <span class="dot ${s.connected ? '' : 'off'}" title="${s.connected ? 'Connected' : 'Disconnected'}"></span>
      <div class="grow"><strong>${esc(s.name)}</strong>${s.isHost ? '<span class="tag">host</span>' : ''}${s.id === you.seatId ? '<span class="tag you">you</span>' : ''}</div>
      ${s.bot ? (host ? `<select data-level="${s.id}" aria-label="Bot difficulty">${S.botLevels.map(l => `<option ${l === s.bot ? 'selected' : ''}>${l}</option>`).join('')}</select>` : `<span class="tag">${esc(s.bot)} bot</span>`) : ''}
      ${host && s.id !== you.seatId ? `<button data-remove="${s.id}">${s.bot ? 'Remove' : 'Kick'}</button>` : ''}
    </div>`).join('') || '<p class="muted">No one is seated.</p>';
  document.querySelectorAll('[data-level]').forEach(el => el.onchange = () => sendMsg({ type: 'botLevel', seatId: el.dataset.level, level: el.value }));
  document.querySelectorAll('[data-remove]').forEach(el => el.onclick = () => sendMsg({ type: 'removeSeat', seatId: el.dataset.remove }));

  const full = S.seats.length >= st.maxSeats;
  $('#addbot').innerHTML = host ? `<div class="actions"><select id="botlevel" aria-label="New bot difficulty">${S.botLevels.map(l => `<option ${l === 'normal' ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button id="addbotbtn" ${full ? 'disabled' : ''}>Add a bot</button>${full ? '<span class="muted small">All seats are filled. Raise the seat limit to add more.</span>' : ''}</div>` : '';
  if ($('#addbotbtn')) $('#addbotbtn').onclick = () => sendMsg({ type: 'addBot', level: $('#botlevel').value });

  // Settings: rebuild only if nothing in them is focused, so typing isn't interrupted.
  const box = $('#settings');
  if (!box.contains(document.activeElement)) {
    box.innerHTML = `<div class="settings-grid">
      <div class="field"><label for="coins">Starting coins</label><input id="coins" type="number" inputmode="numeric" min="${lim.coins[0]}" max="${lim.coins[1]}" value="${st.startCoins}" ${host ? '' : 'disabled'}></div>
      <div class="field"><label for="secs">Seconds per pile</label><input id="secs" type="number" inputmode="numeric" min="${lim.seconds[0]}" max="${lim.seconds[1]}" value="${st.bidSeconds}" ${host ? '' : 'disabled'}></div>
      <div class="field"><label for="maxseats">Seats at the table</label><select id="maxseats" ${host ? '' : 'disabled'}>${Array.from({ length: lim.seats[1] - lim.seats[0] + 1 }, (_, i) => i + lim.seats[0]).map(n => `<option ${n === st.maxSeats ? 'selected' : ''} ${n < S.seats.length ? 'disabled' : ''}>${n}</option>`).join('')}</select></div>
    </div>${host ? '' : '<p class="muted small">Only the host can change these.</p>'}`;
    if (host) {
      $('#coins').onchange = e => sendMsg({ type: 'settings', startCoins: e.target.value });
      $('#secs').onchange = e => sendMsg({ type: 'settings', bidSeconds: e.target.value });
      $('#maxseats').onchange = e => sendMsg({ type: 'settings', maxSeats: e.target.value });
    }
  }

  let a = '';
  if (!you.seatId) a += you.kicked ? '<p class="muted">The host removed you from this table. You can still watch.</p>'
    : `<button class="primary" id="sit" ${full ? 'disabled' : ''}>Take a seat</button>${full ? '<p class="muted small">The table is full; you\'re watching.</p>' : ''}`;
  if (host) a += `<button class="primary big" id="start" ${S.seats.length < 2 ? 'disabled' : ''}>Deal the piles</button>
    <p class="muted small">${S.seats.length < 2 ? 'Fill at least 2 seats with players or bots to start.' : `Everyone seated gets ${st.startCoins} coins and ${st.bidSeconds} seconds per pile. With ${S.seats.length} players there will be ${S.seats.length + 1 >= 7 ? 7 : `${S.seats.length + 1} to 7`} piles.`}</p>`;
  else a += '<p class="muted small">The host deals once everyone is seated.</p>';
  $('#lobbyactions').innerHTML = a;
  if ($('#sit')) $('#sit').onclick = () => sendMsg({ type: 'sit', name: store.get('ap.name', '') });
  if ($('#start')) $('#start').onclick = () => sendMsg({ type: 'start' });
}

// ---------- Game ----------
function renderGame() {
  const g = G(), you = S.you;
  mount('game-' + g.id, `<div class="wrap">
    <header class="bar"><h1>Auction Poker</h1><div class="bar-right"><span id="conn" class="conn"></span><span id="pileLabel" class="pill"></span>${you.isHost ? '<button id="abandon">End game</button>' : ''}</div></header>
    <section class="felt" id="stage"></section>
    <section class="panel" id="bidsWrap">
      <div class="sec-head"><h2 id="bidsTitle">Sealed bids</h2><div class="timer"><span id="timer"></span><small>s</small></div></div>
      <div class="tbar"><div id="tfill"></div></div>
      <div id="bidbox"></div><div id="bidstatus" class="grid"></div>
    </section>
    <section class="panel"><h2>Still to come</h2><div id="upcoming" class="upcoming"></div></section>
    <section class="panel"><h2>Players</h2><div id="players" class="grid"></div></section>
    ${rulesHTML()}</div>`);
  if ($('#abandon')) $('#abandon').onclick = () => { if (confirm('End this game for everyone and go back to the lobby?')) sendMsg({ type: 'lobby' }); };

  const pile = g.piles[g.idx], up = pile.filter(c => c.up).length, last = g.idx === g.piles.length - 1;
  $('#pileLabel').textContent = `Pile ${g.idx + 1} / ${g.piles.length}`;
  let foot;
  if (g.status === 'bidding') foot = `<p class="stage-note">${up} face up, ${pile.length - up} face down. Highest bid wins; the winner pays the second-highest bid.</p>`;
  else {
    const r = g.result;
    const msg = r.winner === null ? 'Nobody bid, so this pile is discarded.'
      : `<strong>${esc(pl(r.winner).name)}</strong> wins the pile${r.tie ? ' on a random tiebreak' : ''} and pays ${r.price} coin${r.price === 1 ? '' : 's'}.`;
    foot = `<div class="result"><p>${msg}</p><div class="inline" style="align-items:center"><span class="muted-felt" id="nextin"></span>${you.isHost ? `<button class="primary" id="next">${last ? 'Go to showdown' : 'Next pile now'}</button>` : ''}</div></div>`;
  }
  $('#stage').innerHTML = `<div class="stage-head"><h2>Pile ${g.idx + 1} of ${g.piles.length}</h2><span>${pile.length} card${pile.length === 1 ? '' : 's'}</span></div>
    <div class="stage-cards">${pileGrid(pile)}</div>${foot}`;
  if ($('#next')) $('#next').onclick = () => sendMsg({ type: 'next' });

  // Your bid (keyed so updates don't wipe a half-typed number)
  const me = you.seatId ? pl(you.seatId) : null;
  const key = [g.id, g.idx, g.status, !!me, g.myBid, me ? me.coins : ''].join('|');
  const box = $('#bidbox');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    if (g.status !== 'bidding') box.innerHTML = '';
    else if (!me) box.innerHTML = '<p class="muted">You\'re watching this game. You can take a seat in the lobby before the next one.</p>';
    else if (me.coins <= 0) box.innerHTML = '<p class="muted">You\'re out of coins, so you sit this pile out.</p>';
    else if (g.myBid !== null) box.innerHTML = `<div class="mybid"><span class="status ok">✓ Your bid is locked</span><span class="amt">${g.myBid}</span><span class="muted">coins, sealed until bidding closes</span></div>`;
    else {
      box.innerHTML = `<div class="mybid-form"><label for="bidin">Your bid <span class="muted">(you have ${me.coins} coins)</span></label>
        <div class="bid-input"><input id="bidin" type="text" inputmode="numeric" autocomplete="off" placeholder="0 to ${me.coins}"><button class="primary" id="bidbtn">Lock bid</button></div>
        <span class="err" id="biderr"></span></div>`;
      const submit = () => {
        const v = $('#bidin').value.trim(), n = v === '' ? 0 : Number(v);
        if (!Number.isInteger(n) || n < 0) { $('#biderr').textContent = 'Enter a whole number of coins.'; return; }
        if (n > me.coins) { $('#biderr').textContent = `You only have ${me.coins} coins.`; return; }
        $('#bidbtn').disabled = true; sendMsg({ type: 'bid', amt: n });
      };
      $('#bidbtn').onclick = submit;
      $('#bidin').onkeydown = e => { if (e.key === 'Enter') submit(); };
      $('#bidin').focus({ preventScroll: true });
    }
  }

  if (g.status === 'bidding') {
    $('#bidsTitle').textContent = 'Sealed bids';
    const sub = new Set(g.submitted);
    $('#bidstatus').innerHTML = g.players.map(p => `<div class="slot"><div class="slot-head"><strong>${esc(p.name)}</strong>${tags(p)}<span class="coins">${p.coins} coins</span></div>
      <span class="status ${sub.has(p.seatId) ? 'ok' : ''}">${p.coins <= 0 ? 'Out of coins' : sub.has(p.seatId) ? '✓ Locked in' : 'Deciding…'}</span></div>`).join('');
  } else {
    $('#bidsTitle').textContent = 'Bids revealed';
    const r = g.result;
    $('#bidstatus').innerHTML = [...r.bids].sort((a, b) => b.amt - a.amt).map(b => {
      const p = pl(b.pid), win = b.pid === r.winner;
      return `<div class="slot ${win ? 'win' : ''}"><div class="slot-head"><strong>${esc(p.name)}</strong>${tags(p)}<span class="coins">${p.coins} coins</span></div>
        <div><span class="amt">${b.amt}</span> <span class="muted">${r.timedOut.includes(b.pid) ? 'no bid in time' : 'bid'}</span></div>${win ? `<span class="status ok">Won, paid ${r.price}</span>` : ''}</div>`;
    }).join('');
  }

  const rest = g.piles.slice(g.idx + 1);
  $('#upcoming').innerHTML = rest.length ? rest.map((p, i) => pileBox(`Pile ${g.idx + 2 + i}`, p, { small: true })).join('')
    : '<p class="muted">This is the last pile.</p>';

  $('#players').innerHTML = g.players.map(p => {
    const cards = cardsOf(p.seatId), vis = cards.filter(c => c.up), hidden = cards.length - vis.length;
    const isMe = p.seatId === you.seatId;
    const label = isMe && cards.length
      ? `Your hand: ${describe(score(cards))}${hidden ? `. Others see ${vis.length ? describe(score(vis)).toLowerCase() : 'nothing'} plus ${hidden} hidden.` : ''}`
      : `Showing: ${vis.length ? describe(score(vis)) : 'Nothing yet'}${hidden ? `, plus ${hidden} hidden` : ''}`;
    return `<div class="slot player ${isMe ? 'me' : ''}"><div class="slot-head"><strong>${esc(p.name)}</strong>${tags(p)}<span class="coins">${p.coins} coins</span></div>
      ${wonPiles(p.seatId)}
      <p class="small ${isMe ? '' : 'muted'}">${label}</p>
      ${isMe && hidden ? '<p class="small muted"><span class="legend-private"></span> Dashed cards are face down to everyone else.</p>' : ''}</div>`;
  }).join('');
  tick();
}

// ---------- Showdown ----------
function renderShowdown() {
  const g = G(), you = S.you;
  const res = g.players.map(p => { const cards = cardsOf(p.seatId); return { p, cards, score: score(cards), best: new Set(bestFive(cards)) }; }).sort((a, b) => cmp(b.score, a.score));
  const top = res[0].score, winners = res.filter(r => top[0] >= 0 && cmp(r.score, top) === 0);
  mount('showdown-' + g.id, `<div class="wrap"><header class="bar"><h1>Auction Poker</h1><span id="conn" class="conn"></span></header>
    <section class="felt winner-banner" id="banner"></section>
    <section class="rank-list" id="ranks" style="margin-top:16px"></section>${rulesHTML()}</div>`);
  const headline = !winners.length ? 'Nobody won any cards' : winners.length === 1 ? `${esc(winners[0].p.name)} wins` : `Split pot: ${winners.map(w => esc(w.p.name)).join(' and ')}`;
  $('#banner').innerHTML = `<h2>${headline}</h2><p>${winners.length ? describe(top) : 'Every pile went unclaimed.'}</p>
    <div class="result"><span></span>${you.isHost ? `<div class="inline"><button class="primary" id="again">Play again</button><button id="tolobby">Change seats or rules</button></div>` : '<span class="muted-felt">Waiting for the host to start another game.</span>'}</div>`;
  if ($('#again')) $('#again').onclick = () => sendMsg({ type: 'start' });
  if ($('#tolobby')) $('#tolobby').onclick = () => sendMsg({ type: 'lobby' });
  let place = 0, prev = null;
  $('#ranks').innerHTML = res.map((r, i) => {
    if (!prev || cmp(r.score, prev) !== 0) place = i + 1; prev = r.score;
    return `<div class="panel rank-row ${place === 1 && top[0] >= 0 ? 'first' : ''}"><div class="place">${place}</div>
      <div style="display:grid;gap:8px;min-width:0">
        <div class="slot-head"><strong>${esc(r.p.name)}</strong>${tags(r.p)}<span class="coins">${r.p.coins} coins left</span></div>
        <div class="handname">${describe(r.score)}</div>
        ${wonPiles(r.p.seatId, { mark: c => ({ hi: r.best.has(c) && r.cards.length > 5, dim: !r.best.has(c) }) })}
        <p class="small muted">Won ${r.p.won} pile${r.p.won === 1 ? '' : 's'} for ${r.p.spent} coins total.</p></div></div>`;
  }).join('');
}

// ---------- Timer ----------
function tick() {
  if (!S || !S.game) return;
  const g = S.game;
  const t = $('#timer'); if (!t) return;
  const left = g.status === 'bidding' ? Math.max(0, deadline - Date.now()) : 0;
  t.textContent = Math.ceil(left / 1000);
  $('#tfill').style.width = (left / (g.bidSeconds * 1000) * 100) + '%';
  $('#bidsWrap').classList.toggle('urgent', left > 0 && left <= 5000);
  if (g.status === 'bidding' && left <= 0 && $('#bidbtn')) { $('#bidbtn').disabled = true; $('#bidin').disabled = true; }
  const n = $('#nextin');
  if (n) { const s = Math.ceil(Math.max(0, nextDeadline - Date.now()) / 1000); n.textContent = g.idx === g.piles.length - 1 ? `Showdown in ${s}s` : `Next pile in ${s}s`; }
}
setInterval(tick, 200);

// ---------- Start ----------
const startCode = new URLSearchParams(location.search).get('room') || store.get('ap.room', '');
renderHome();
connect();
if (startCode && store.get('ap.name', '')) pendingJoin = { type: 'join', code: startCode.toUpperCase(), clientId, name: store.get('ap.name', '') };
