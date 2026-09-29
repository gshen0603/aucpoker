// War: you against the computer, played entirely in the browser.
(function () {
  const SUITS = ['s', 'h', 'd', 'c'];
  const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const NAME = { 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
  const WAR_DOWN = 3;
  const $ = s => document.querySelector(s);

  let you, cpu, table, turns, over, autoTimer = null;

  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  const label = c => LABEL[c.rank] || String(c.rank);
  const name = c => NAME[c.rank] || String(c.rank);

  function newGame() {
    const deck = [];
    for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push({ rank: r, suit: s });
    shuffle(deck);
    you = deck.slice(0, 26); cpu = deck.slice(26);
    table = { you: [], cpu: [] }; turns = 0; over = false;
    stopAuto();
    draw('Flip to start.', '');
  }

  // Lays one card from each hand; returns false if someone ran out.
  function lay(faceUp) {
    if (!you.length || !cpu.length) return false;
    table.you.push({ ...you.shift(), up: faceUp });
    table.cpu.push({ ...cpu.shift(), up: faceUp });
    return true;
  }

  function turn() {
    if (over) return;
    turns++;
    table = { you: [], cpu: [] };
    lay(true);
    let wars = 0;
    for (;;) {
      const a = table.you[table.you.length - 1], b = table.cpu[table.cpu.length - 1];
      if (a.rank !== b.rank) { settle(a.rank > b.rank, a, b, wars); return; }
      wars++;
      // A player who can't finish the war plays what they have, keeping their last card to show.
      if (!you.length || !cpu.length) { settle(!!you.length, a, b, wars, true); return; }
      const down = Math.min(WAR_DOWN, you.length - 1, cpu.length - 1);
      for (let i = 0; i < down; i++) lay(false);
      lay(true);
    }
  }

  function settle(youWin, a, b, wars, outOfCards) {
    const pot = shuffle([...table.you, ...table.cpu].map(c => ({ rank: c.rank, suit: c.suit })));
    (youWin ? you : cpu).push(...pot);
    const warText = wars ? (wars > 1 ? `${wars} wars! ` : 'War! ') : '';
    let msg = outOfCards
      ? `${warText}${youWin ? 'The computer' : 'You'} ran out of cards mid-war.`
      : `${warText}${youWin ? 'Your' : 'Their'} ${name(youWin ? a : b)} beats ${youWin ? 'their' : 'your'} ${name(youWin ? b : a)}. ${youWin ? 'You take' : 'They take'} ${pot.length}.`;
    if (!cpu.length || !you.length) {
      over = true; stopAuto();
      msg = you.length ? `You win the war in ${turns} turns!` : `The computer wins in ${turns} turns.`;
    }
    draw(msg, youWin ? 'win' : 'lose');
  }

  function cardHTML(c) {
    if (!c.up) return '<span class="card back" aria-label="Face-down card"></span>';
    const red = c.suit === 'h' || c.suit === 'd';
    return `<span class="card s-${c.suit}${red ? ' red' : ''}" aria-label="${name(c)} of ${c.suit}"><span class="r">${label(c)}</span><span class="s">${SUIT_SYM[c.suit]}</span></span>`;
  }

  function draw(msg, tone) {
    $('#youRow').innerHTML = table.you.map(cardHTML).join('');
    $('#cpuRow').innerHTML = table.cpu.map(cardHTML).join('');
    $('#youCount').textContent = `${you.length} cards`;
    $('#cpuCount').textContent = `${cpu.length} cards`;
    $('#share').style.width = `${(you.length / 52) * 100}%`;
    $('#msg').textContent = msg;
    $('#msg').className = 'war-msg ' + tone;
    $('#turns').textContent = turns ? `Turn ${turns}` : '';
    $('#flip').disabled = over;
    $('#auto').disabled = over;
  }

  function stopAuto() { clearInterval(autoTimer); autoTimer = null; $('#auto').textContent = 'Auto-play'; }
  function toggleAuto() {
    if (autoTimer) { stopAuto(); return; }
    autoTimer = setInterval(turn, 250);
    $('#auto').textContent = 'Stop';
  }

  $('#flip').onclick = turn;
  $('#auto').onclick = toggleAuto;
  $('#restart').onclick = newGame;
  document.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && e.target === document.body) { e.preventDefault(); turn(); } });
  newGame();
})();
