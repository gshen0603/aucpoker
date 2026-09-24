// Bot bidding. Bots see what a human in their seat sees: face-up cards, the face-down cards
// in piles they bought, who owns which pile, and coin counts. Other hidden cards stay unknown.
// A card object with a rank is known to the bot; { up: false } with no rank is unknown.
const P = require('./public/game.js');

const key = c => c.rank + c.suit;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const noise = (spread) => 1 - spread + Math.random() * spread * 2;

function cardsOf(ctx, seatId, piles) { return piles.filter((_, i) => ctx.owners[i] === seatId).flat(); }

// Easy: spends a rough share of its budget on everything, mostly at random.
function easy(ctx) {
  const { me, piles, idx } = ctx;
  const left = piles.length - idx;
  return Math.round(me.coins / left * (0.3 + Math.random() * 1.2));
}

// Normal: looks at how much the pile's face-up cards improve its visible hand.
function normal(ctx) {
  const { me, piles, idx } = ctx;
  const left = piles.length - idx, pile = piles[idx];
  const up = pile.filter(c => c.up), down = pile.length - up.length;
  const mine = cardsOf(ctx, me.seatId, piles).filter(c => c.rank);
  const before = Math.max(0, P.score(mine)[0]), after = P.score([...mine, ...up])[0];
  let q = 0.45 + 0.35 * Math.max(0, after - before) + 0.12 * down + up.reduce((s, c) => s + (c.rank - 9) * 0.03, 0);
  if (left === 1) q = Math.max(q, 0.9);
  return Math.round(me.coins / left * q * noise(0.25));
}

// Hard: Monte Carlo. Samples the hidden cards from the unseen pool, then estimates how much
// winning this pile raises its chance of holding the best hand versus letting a rival take it.
// Coins are worthless at the showdown, so it plans to spend everything by the last pile.
function hard(ctx, samples = 300) {
  const { me, players, piles, idx } = ctx;
  const left = piles.length - idx;
  const seen = new Set(piles.flat().filter(c => c.rank).map(key));
  const pool = P.makeDeck(players.length).filter(c => !seen.has(key(c)));
  const opps = players.filter(p => p.seatId !== me.seatId);
  let pWith = 0, pOther = 0;
  const winShare = (mine, others) => {
    const s = P.score(mine); let best = 0, ties = 0;
    for (const o of others) { const c = P.cmp(P.score(o), s); if (c > 0) return 0; if (c === 0) ties++; }
    return best + 1 / (1 + ties);
  };
  for (let n = 0; n < samples; n++) {
    const fill = P.shuffle(pool.slice()); let fi = 0;
    const full = piles.map(p => p.map(c => (c.rank ? c : fill[fi++])));
    const pile = full[idx];
    // Future piles go to a random player, weighted by coins left, so the first pile isn't overvalued.
    const owners = ctx.owners.slice();
    const weights = players.map(p => p.coins + 5), wsum = weights.reduce((a, b) => a + b, 0);
    for (let i = idx + 1; i < full.length; i++) {
      let r = Math.random() * wsum, j = 0; while ((r -= weights[j]) > 0) j++;
      owners[i] = players[j].seatId;
    }
    const sctx = { owners };
    const mine = cardsOf(sctx, me.seatId, full);
    const theirs = opps.map(o => cardsOf(sctx, o.seatId, full));
    pWith += winShare([...mine, ...pile], theirs);
    let other = 0;
    for (let j = 0; j < opps.length; j++) {
      const t = theirs.map((c, k) => (k === j ? [...c, ...pile] : c));
      other += winShare(mine, t);
    }
    pOther += opps.length ? other / opps.length : 0;
  }
  const delta = (pWith - pOther) / samples;
  if (left === 1) return delta > 0.02 ? me.coins : Math.round(me.coins * 0.15 * Math.random());
  const frac = clamp((0.4 + 8 * Math.max(0, delta)) / left, 0, 0.9);
  return Math.round(me.coins * frac * noise(0.15));
}

function botBid(level, ctx) {
  if (ctx.me.coins <= 0) return 0;
  const fn = level === 'easy' ? easy : level === 'hard' ? hard : normal;
  return clamp(Math.floor(fn(ctx)) || 0, 0, ctx.me.coins);
}

module.exports = { botBid };
