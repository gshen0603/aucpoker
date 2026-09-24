// Shared game logic — loaded by the server (require) and the browser (window.Poker).
(function (root) {
  const RANKS = [9, 10, 11, 12, 13, 14];
  const SUITS = ['s', 'h', 'd', 'c'];
  const RANK_LABEL = { 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const RANK_ONE = { 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
  const RANK_MANY = { 9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' };
  const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const SUIT_NAME = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
  // Remapped ranking: flush sits directly under straight flush.
  const CAT = { HIGH: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4, FULL_HOUSE: 5, QUADS: 6, FLUSH: 7, STRAIGHT_FLUSH: 8 };
  const CAT_NAME = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Full house', 'Four of a kind', 'Flush', 'Straight flush'];
  // The only straights: 9-10-J-Q-K and 10-J-Q-K-A (A-9-10-J-Q is NOT a straight).
  const STRAIGHTS = [[10, 11, 12, 13, 14], [9, 10, 11, 12, 13]]; // high first

  function makeDeck() { const d = []; for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s, up: false }); return d; }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function straightHighFromSet(set) { for (const w of STRAIGHTS) if (w.every(r => set.has(r))) return w[4]; return 0; }
  function hasQuads(cards) { const c = {}; for (const x of cards) { c[x.rank] = (c[x.rank] || 0) + 1; if (c[x.rank] >= 4) return true; } return false; }
  function hasStraightFlush(cards) {
    for (const s of SUITS) if (straightHighFromSet(new Set(cards.filter(c => c.suit === s).map(c => c.rank)))) return true;
    return false;
  }
  function isForbidden(cards) { return hasQuads(cards) || hasStraightFlush(cards); }

  const MAX_PILES = 7;
  // Pile count is random from (players + 1) to 7. Each card face up with p=0.5. Re-deal until
  // no quads or straight flush among ALL face-up cards, and none inside any single pile.
  function pileCountFor(players) {
    const lo = Math.min(players + 1, MAX_PILES);
    return lo + Math.floor(Math.random() * (MAX_PILES - lo + 1));
  }
  function dealPiles(players) {
    const n = pileCountFor(players);
    for (let attempt = 1; attempt <= 200000; attempt++) {
      const deck = shuffle(makeDeck());
      deck.forEach(c => { c.up = Math.random() < 0.5; });
      if (isForbidden(deck.filter(c => c.up))) continue;
      const cuts = shuffle([...Array(deck.length - 1).keys()].map(i => i + 1)).slice(0, n - 1).sort((a, b) => a - b);
      const piles = []; let prev = 0;
      for (const g of [...cuts, deck.length]) { piles.push(deck.slice(prev, g)); prev = g; }
      if (piles.some(isForbidden)) continue;
      return piles;
    }
    throw new Error('Could not find a legal deal');
  }

  // Best-hand score for ANY number of cards, computed directly. Returns [category, tiebreakers...].
  function score(cards) {
    if (!cards.length) return [-1];
    const cnt = {}, bySuit = { s: [], h: [], d: [], c: [] };
    for (const c of cards) { cnt[c.rank] = (cnt[c.rank] || 0) + 1; bySuit[c.suit].push(c.rank); }
    const desc = (a, b) => b - a;
    const ranksDesc = Object.keys(cnt).map(Number).sort(desc);
    const kick = (excl, n) => ranksDesc.filter(r => !excl.includes(r)).slice(0, n);
    let sf = 0, flush = null;
    for (const s of SUITS) {
      const rs = bySuit[s];
      if (rs.length >= 5) {
        const h = straightHighFromSet(new Set(rs));
        if (h > sf) sf = h;
        const top = rs.slice().sort(desc).slice(0, 5);
        if (!flush || cmp(top, flush) > 0) flush = top;
      }
    }
    if (sf) return [CAT.STRAIGHT_FLUSH, sf];
    if (flush) return [CAT.FLUSH, ...flush];
    const quads = ranksDesc.filter(r => cnt[r] >= 4), trips = ranksDesc.filter(r => cnt[r] >= 3), pairs = ranksDesc.filter(r => cnt[r] >= 2);
    if (quads.length) return [CAT.QUADS, quads[0], ...kick([quads[0]], 1)];
    if (trips.length) { const fh = pairs.filter(r => r !== trips[0]); if (fh.length) return [CAT.FULL_HOUSE, trips[0], fh[0]]; }
    const st = straightHighFromSet(new Set(ranksDesc));
    if (st) return [CAT.STRAIGHT, st];
    if (trips.length) return [CAT.TRIPS, trips[0], ...kick([trips[0]], 2)];
    if (pairs.length >= 2) return [CAT.TWO_PAIR, pairs[0], pairs[1], ...kick([pairs[0], pairs[1]], 1)];
    if (pairs.length) return [CAT.PAIR, pairs[0], ...kick([pairs[0]], 3)];
    return [CAT.HIGH, ...ranksDesc.slice(0, 5)];
  }
  function cmp(a, b) { const n = Math.max(a.length, b.length); for (let i = 0; i < n; i++) { const x = a[i] ?? -1, y = b[i] ?? -1; if (x !== y) return x - y; } return 0; }

  // Which 5 cards make the hand (for highlighting). Exhaustive but only used at showdown.
  function bestFive(cards) {
    if (cards.length <= 5) return [...cards];
    const target = score(cards), pick = [], k = cards.length; let found = null;
    (function rec(start) {
      if (found) return;
      if (pick.length === 5) { if (cmp(score(pick), target) === 0) found = [...pick]; return; }
      for (let i = start; i <= k - (5 - pick.length) && !found; i++) { pick.push(cards[i]); rec(i + 1); pick.pop(); }
    })(0);
    return found || cards.slice(0, 5);
  }

  function describe(s) {
    const c = s[0], a = s[1], b = s[2];
    switch (c) {
      case -1: return 'No cards';
      case CAT.STRAIGHT_FLUSH: return `Straight flush, ${RANK_ONE[a]} high`;
      case CAT.FLUSH: return `Flush, ${RANK_ONE[a]} high`;
      case CAT.QUADS: return `Four ${RANK_MANY[a]}`;
      case CAT.FULL_HOUSE: return `Full house, ${RANK_MANY[a]} full of ${RANK_MANY[b]}`;
      case CAT.STRAIGHT: return `Straight, ${RANK_ONE[a]} high`;
      case CAT.TRIPS: return `Three ${RANK_MANY[a]}`;
      case CAT.TWO_PAIR: return `Two pair, ${RANK_MANY[a]} and ${RANK_MANY[b]}`;
      case CAT.PAIR: return `Pair of ${RANK_MANY[a]}`;
      default: return `${RANK_ONE[a]} high`;
    }
  }

  // Sealed-bid second-price auction. bids: [{pid, amt}]
  function resolveAuction(bids) {
    const sorted = [...bids].sort((a, b) => b.amt - a.amt);
    if (!sorted.length || sorted[0].amt <= 0) return { winner: null, price: 0, tie: false };
    const tied = sorted.filter(b => b.amt === sorted[0].amt);
    const w = tied[Math.floor(Math.random() * tied.length)];
    return { winner: w.pid, price: sorted.length > 1 ? sorted[1].amt : 0, tie: tied.length > 1 };
  }

  const api = { RANKS, SUITS, RANK_LABEL, RANK_ONE, SUIT_SYM, SUIT_NAME, CAT, CAT_NAME, makeDeck, shuffle, dealPiles, pileCountFor, MAX_PILES, isForbidden, score, cmp, bestFive, describe, resolveAuction };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Poker = api;
})(this);
