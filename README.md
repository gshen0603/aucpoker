# Auction Poker

A multiplayer card game. The deck has only 9 through A (24 cards) with 2 or 3 players, or 8 through A
(28 cards) with 4, dealt into 3 to 8 piles with each card face up 60% of the time. Players win piles
in sealed second-price auctions, then the best five-card hand wins. Flushes rank just below straight
flushes (above four of a kind), and the only straights are 9-K and 10-A, plus 8-Q with the 4-player deck.

The server holds the full deal and every sealed bid, so browsers never receive face-down cards
or other players' bids until they're revealed.

## Run it on your computer

You need Node.js 18 or newer (https://nodejs.org).

```
cd auction-poker
npm install
npm start
```

Open http://localhost:3000. To play with people on the same Wi-Fi, have them open
`http://<your computer's local IP>:3000` (find it with `ipconfig` on Windows or
`ipconfig getifaddr en0` on a Mac).


## How a game works

- One person starts a table and becomes the host. Everyone else joins with the 4-letter code
  or the invite link.
- The host can add bots (easy, normal, hard), change a bot's difficulty, kick players, and set
  seconds per pile, games in a row, and the number of seats. Everyone starts with 100 coins.
- Each pile is open for bidding until the timer ends or everyone has locked in. The highest bid
  wins and pays the second-highest bid. Bids are revealed for a few seconds, then the next pile
  opens automatically (the host can skip ahead).
- If the host disconnects for 20 seconds, hosting passes to the next connected player.
- Refreshing or reconnecting puts you back in your seat.

## Bots

Bots see exactly what a human sees: face-up cards, pile owners, and coin counts.

- **Easy** spends a random share of its budget.
- **Normal** bids more when the face-up cards improve its visible hand.
- **Hard** runs a Monte Carlo simulation over the hidden cards and future piles, estimates how
  much winning this pile raises its chance of the best hand versus a rival taking it, and plans
  to spend all its coins by the last pile (coins are worth nothing at the showdown).

## Files

- `server.js` runs the web server, tables, timers, and auctions.
- `bots.js` holds the bot strategies.
- `public/game.js` has the deck, deal rules, and hand ranking (shared by server and browser).
- `public/app.js`, `public/index.html`, and `public/style.css` make up the web page.
