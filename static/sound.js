// Game show sounds: CC0 recordings in sfx/ (see sfx/CREDITS.md), decoded once the board is clicked.
const Sound = (() => {
  const NAMES = ['reveal', 'strike', 'buzzin', 'roundwin', 'gamewin', 'roundstart'];
  let ctx = null;
  const buffers = {};
  function unlock() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      for (const n of NAMES) {
        fetch(`sfx/${n}.mp3`).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)).then(buf => buffers[n] = buf).catch(() => {});
      }
    }
    if (ctx.state === 'suspended') ctx.resume();
  }
  function play(n, gain = 1) {
    if (!ctx || !buffers[n]) return;
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buffers[n];
    g.gain.value = gain;
    src.connect(g).connect(ctx.destination);
    src.start();
  }
  return {
    unlock,
    ding: () => play('reveal'),
    strike: () => play('strike'),
    buzzIn: () => play('buzzin', .8),
    round: () => play('roundstart', .8),
    win: () => play('roundwin'),
    gameWin: () => play('gamewin'),
    loaded: () => Object.keys(buffers),
  };
})();
