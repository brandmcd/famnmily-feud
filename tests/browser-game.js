// Full-game test: host phone, projector board and two player phones open at once.
const BASE = Bun.argv[2] || 'http://127.0.0.1:8098/';
// Usage: bun tests/browser-game.js [base_url]   (needs chromium; screenshots go to $OUT or /tmp/feud-test)
const OUT = (process.env.OUT || '/tmp/feud-test') + '/';
const port = 9800 + Math.floor(Math.random() * 100);
const proc = Bun.spawn(['chromium', '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, '--user-data-dir=/tmp/cdp/game' + port, 'about:blank'], {stderr: 'ignore', stdout: 'ignore'});
for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await Bun.sleep(100); } }
const results = [];
const check = (name, ok, got) => { results.push([ok, name, got]); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : '=> ' + JSON.stringify(got)); };

async function page(url, w, h, mobile) {
  // Each tab gets its own browser context so localStorage (player identity) is separate.
  const ctxWs = new WebSocket((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  await new Promise(r => ctxWs.onopen = r);
  let bid = 0; const bp = {};
  ctxWs.onmessage = e => { const m = JSON.parse(e.data); if (bp[m.id]) { bp[m.id](m); delete bp[m.id]; } };
  const bsend = (method, params = {}) => new Promise(r => { const i = ++bid; bp[i] = r; ctxWs.send(JSON.stringify({id: i, method, params})); });
  const {result: {browserContextId}} = await bsend('Target.createBrowserContext');
  const {result: {targetId}} = await bsend('Target.createTarget', {url: 'about:blank', browserContextId});
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = {}; const errors = [];
  ws.onmessage = e => { const m = JSON.parse(e.data);
    if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({id: i, method, params})); });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: 1, mobile});
  await send('Page.navigate', {url});
  await Bun.sleep(1500);
  const p = {
    errors,
    async ev(expr) { const r = await send('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true});
      if (r.result?.exceptionDetails) throw new Error('eval: ' + expr + ' ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200));
      return r.result?.result?.value; },
    async shot(name) { const s = await send('Page.captureScreenshot', {format: 'png'}); await Bun.write(OUT + name + '.png', Buffer.from(s.result.data, 'base64')); },
    async go(u) { await send('Page.navigate', {url: u}); await Bun.sleep(1500); },
  };
  return p;
}
const wait = (ms = 700) => Bun.sleep(ms);
const text = (p, sel) => p.ev(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||''`);
// Click a host button by its data-a, optionally matching data-extra or visible text.
const tap = async (p, a, match = '') => {
  const ok = await p.ev(`(() => { const bs = [...document.querySelectorAll('button[data-a="${a}"]')].filter(b => !${JSON.stringify(match)} || (b.dataset.extra||'').includes(${JSON.stringify(match)}) || b.textContent.includes(${JSON.stringify(match)}));
    if (!bs.length) return false; bs[0].click(); return true; })()`);
  if (!ok) check(`host button ${a} ${match} exists`, false, 'missing');
  await wait();
};
const hostSay = p => text(p, '.say');
const scores = async p => JSON.parse(await p.ev(`JSON.stringify({red: +document.querySelector('#sc-red .s').textContent, blue: +document.querySelector('#sc-blue .s').textContent, bank: +document.querySelector('#bank').textContent})`));
const boardScores = async b => JSON.parse(await b.ev(`JSON.stringify({red: +document.querySelector('#red .score').textContent, blue: +document.querySelector('#blue .score').textContent, bank: +document.querySelector('#bank').textContent})`));
const openTiles = b => b.ev(`[...document.querySelectorAll('#tiles .tile')].map(t => t.classList.contains('open') ? 1 : 0).join('')`);
const state = p => p.ev('document.body.dataset.state || ""');
const msg = p => text(p, '#msg');

await Bun.$`mkdir -p ${OUT}`;
// 1. Create from the landing page like a phone would.
const host = await page(BASE, 390, 1400, true);
await host.ev(`document.querySelector('#host').click()`); await wait(2000);
const hostURL = await host.ev('location.href');
const CODE = new URL(hostURL).searchParams.get('g');
check('landing creates game and opens host page', /host\?g=[A-Z]{4}&k=/.test(hostURL), hostURL);
await host.shot('01-host-lobby');

const board = await page(BASE + 'board?g=' + CODE, 1920, 1080, false);
await board.ev(`document.querySelector('#sound').click()`); await wait(300);
check('board shows lobby with code', (await text(board, '#lobby-code')) === CODE && await board.ev(`document.querySelector('#lobby').classList.contains('show')`), await text(board, '#lobby-code'));

// Players join through the landing page code box.
const sam = await page(BASE, 390, 844, true);
await sam.ev(`document.querySelector('#join-code').value='${CODE.toLowerCase()}'; document.querySelector('#join').click()`); await wait(1500);
await sam.ev(`document.querySelector('#name').value='Sam'; document.querySelector('#pick-red').click(); document.querySelector('#join').click()`); await wait();
const ishan = await page(BASE + 'play?g=' + CODE, 390, 844, true);
await ishan.ev(`document.querySelector('#name').value='Ishan'; document.querySelector('#pick-blue').click(); document.querySelector('#join').click()`); await wait();
check('players see waiting message', (await msg(sam)).includes('Waiting') && (await msg(ishan)).includes('Waiting'), [await msg(sam), await msg(ishan)]);
check('board lobby counts 2 joined', (await text(board, '#lobby-players')).includes('2'), await text(board, '#lobby-players'));
check('host shows 2 buzzers joined', (await text(host, '#players')).includes('2'), await text(host, '#players'));

// Rename red, set 3 rounds.
await host.ev(`window.prompt = () => 'Gearheads'`);
await host.ev(`document.querySelector('#menu-open').click()`); await wait(200);
await host.ev(`document.querySelector('[data-rename="red"]').click()`); await wait();
await host.ev(`document.querySelector('[data-close]').click()`); await wait(200);
check('rename shows on board', (await text(board, '#red .name')) === 'Gearheads', await text(board, '#red .name'));
await tap(host, 'plan', '"plan":3');
check('plan 3 rounds shows 3 lineup slots', (await host.ev(`document.querySelectorAll('.slot').length`)) === 3, await host.ev(`document.querySelectorAll('.slot').length`));
check('start button names round 1', (await text(host, '[data-a="start_round"]')).startsWith('Start round 1'), await text(host, '[data-a="start_round"]'));
await host.ev(`document.querySelector('#menu-open').click()`); await wait(200);
check('menu sheet opens with rules', !(await host.ev(`document.querySelector('#sheet').hidden`)) && (await text(host, '#panel')).includes('How Family Feud works'), '');
await host.ev(`document.querySelector('[data-close]').click()`); await wait(200);
await host.shot('02-host-setup');

// ---- Round 1: buzz, face-off, play, three strikes, steal works.
await tap(host, 'start_round');
check('board leaves lobby', !(await board.ev(`document.querySelector('#lobby').classList.contains('show')`)), '');
check('board round label', (await text(board, '#round')).startsWith('Round 1 of 3'), await text(board, '#round'));
check('players open for buzz', (await state(sam)) === 'open' && (await state(ishan)) === 'open', [await state(sam), await state(ishan)]);
check('board tiles all hidden', !(await openTiles(board)).includes('1'), await openTiles(board));
const boardQ = await text(board, '#question');
const hostQ = await text(host, '.qtext');
check('board and host show same question', boardQ.includes(hostQ), [boardQ, hostQ]);
check('board does not leak answers', await board.ev(`fetch('api/state?g=${CODE}').then(r=>r.json()).then(s=>s.question.answers.every(a=>a===null))`), '');
await board.shot('03-board-faceoff');
await sam.ev(`document.querySelector('.q').click()`); await wait();
check('Sam sees first (gold)', (await state(sam)) === 'first', await state(sam));
check('Ishan sees lost (gray)', (await state(ishan)) === 'lost' && (await msg(ishan)).includes('Sam'), [await state(ishan), await msg(ishan)]);
check('board banner names Sam', (await board.ev(`document.querySelector('#buzz').className`)).includes('show red') && (await text(board, '#buzz')).includes('Sam'), await text(board, '#buzz'));
check('host script names Sam', (await hostSay(host)).includes("Sam, what's your answer"), await hostSay(host));
await ishan.ev(`document.querySelector('.q').click()`); await wait();
check('second buzz ignored', (await state(sam)) === 'first' && (await text(board, '#buzz')).includes('Sam'), '');
await sam.shot('04-sam-first'); await ishan.shot('05-ishan-lost'); await host.shot('06-host-buzzed');
// Sam names answer #2; host reveals it in the face-off, then gives red control.
const pts = JSON.parse(await host.ev(`JSON.stringify(S.question.answers.map(a=>a.points))`));
await tap(host, 'reveal', '"i":1');
check('face-off reveal adds to bank', (await scores(host)).bank === pts[1], [await scores(host), pts]);
check('board tile 2 flipped', (await openTiles(board))[1] === '1', await openTiles(board));
// Undo then redo reveal.
await tap(host, 'hide', '"i":1');
check('hide removes from bank and board', (await scores(host)).bank === 0 && (await openTiles(board))[1] === '0', [await scores(host), await openTiles(board)]);
await tap(host, 'reveal', '"i":1');
check('face-off asks Blue next', (await hostSay(host)).includes('Blue Alliance, can you beat that'), await hostSay(host));
await tap(host, 'strike');
check('Blue miss means Red wins face-off', (await hostSay(host)).includes('Gearheads wins the face-off'), await hostSay(host));
await tap(host, 'control', '"team":"red"');
check('host shows red playing', (await text(host, '.step')).includes('Gearheads playing'), await text(host, '.step'));
check('board red tagged Playing', await board.ev(`document.querySelector('#red').classList.contains('control')`), '');
check('players see red playing', (await msg(ishan)).includes('Gearheads is playing') && (await state(sam)) === 'wait', [await msg(ishan), await state(sam)]);
await tap(host, 'reveal', '"i":0');
check('bank sums revealed answers', (await scores(host)).bank === pts[0] + pts[1], await scores(host));
await tap(host, 'strike'); await tap(host, 'strike');
check('board shows 2 strike boxes for red', (await board.ev(`document.querySelectorAll('#strikes-red span').length`)) === 2, '');
await tap(host, 'unstrike');
check('undo strike', (await board.ev(`document.querySelectorAll('#strikes-red span').length`)) === 1, '');
await tap(host, 'strike'); await tap(host, 'strike');
check('three strikes goes to steal', (await text(host, '.step')).includes('steal') && (await hostSay(host)).includes('Blue Alliance, huddle up'), [await text(host, '.step'), await hostSay(host)]);
check('board shows Steal tag on blue', (await text(board, '#blue .tag')) === 'Steal' && await board.ev(`document.querySelector('#blue').classList.contains('control')`), await text(board, '#blue .tag'));
await host.shot('07-host-steal'); await board.shot('08-board-steal');
const bank1 = (await scores(host)).bank;
// Blue names answer #3 to steal.
await tap(host, 'reveal', '"i":2');
const bankSteal = bank1 + pts[2];
await tap(host, 'steal', 'true');
let sc = await scores(host);
check('steal gives whole bank to blue', sc.blue === bankSteal && sc.red === 0 && sc.bank === 0, [sc, bankSteal]);
check('board scores match host', JSON.stringify(await boardScores(board)) === JSON.stringify(sc), [await boardScores(board), sc]);
check('round over script', (await hostSay(host)).includes('Blue Alliance takes the round'), await hostSay(host));
check('no strike button after round', !(await host.ev(`!!document.querySelector('[data-a="strike"]')`)), '');
check('next offers round 2 double', (await text(host, '[data-a="start_round"]')).includes('Start round 2') && (await text(host, '[data-a="start_round"]')).includes('Double'), await text(host, '[data-a="start_round"]'));
await tap(host, 'reveal_all');
const nAns1 = await host.ev('S.question.answers.length');
check('reveal all flips every answer tile, bank unchanged', !(await openTiles(board)).slice(0, nAns1).includes('0') && (await scores(host)).blue === bankSteal, [await openTiles(board), await scores(host)]);
await host.shot('09-host-round-done'); await board.shot('10-board-round-done');

// ---- Round 2 (double): manual buzz, blue clears the board.
await tap(host, 'start_round');
check('board says double points', (await text(board, '#round')).includes('Double'), await text(board, '#round'));
check('host script says double', (await hostSay(host)).includes('double'), await hostSay(host));
await tap(host, 'buzz', '"team":"blue"');
check('manual buzz shows on board', (await text(board, '#buzz')).includes('Blue Alliance'), await text(board, '#buzz'));
await tap(host, 'reveal', '"i":0');
check('#1 answer wins face-off at once', (await hostSay(host)).includes('Blue Alliance wins the face-off'), await hostSay(host));
await tap(host, 'control', '"team":"blue"');
const blueBefore2 = (await scores(host)).blue;
const n2 = await host.ev('S.question.answers.length');
const pts2 = JSON.parse(await host.ev(`JSON.stringify(S.question.answers.map(a=>a.points))`));
for (let i = 1; i < n2; i++) await tap(host, 'reveal', `"i":${i}`);
sc = await scores(host);
const clear2 = pts2.reduce((a, b) => a + b, 0) * 2;
check('clearing the board auto-awards control team x2', sc.blue === blueBefore2 + clear2 && (await text(host, '.step')).includes('done'), [sc, clear2]);
check('no reveal-all button when board is clear', !(await host.ev(`!!document.querySelector('[data-a="reveal_all"]')`)), '');
check('next offers last round triple', (await text(host, '[data-a="start_round"]')).includes('Start round 3') && (await text(host, '[data-a="start_round"]')).includes('Triple'), await text(host, '[data-a="start_round"]'));

// ---- Round 3 (triple): change the question in the lineup, red ends round early.
await host.ev(`document.querySelector('[data-pick="2"]').click()`); await wait(200);
const alt = await host.ev(`(() => { const b = [...document.querySelectorAll('.pick')].find(b => !b.disabled && !b.classList.contains('sel')); b.click(); return b.firstChild.textContent.trim(); })()`);
await wait();
check('lineup pick updates start button', (await text(host, '[data-a="start_round"]')).includes(alt.slice(0, 20)), [alt, await text(host, '[data-a="start_round"]')]);
await tap(host, 'start_round');
check('board asks chosen question', (await text(board, '#question')).includes(alt.slice(0, 20)), await text(board, '#question'));
check('host says last round triple', (await hostSay(host)).includes('triple'), await hostSay(host));
await ishan.ev(`document.querySelector('.q').click()`); await wait();
await host.ev(`document.querySelector('[data-skip]').click()`); await wait(200);
await tap(host, 'control', '"team":"red"');
const pts3 = JSON.parse(await host.ev(`JSON.stringify(S.question.answers.map(a=>a.points))`));
await tap(host, 'reveal', '"i":0');
await host.ev(`document.querySelector('#menu-open').click()`); await wait(200);
await tap(host, 'award', '"team":"red"');
sc = await scores(host);
check('end round now gives red bank x3', sc.red === pts3[0] * 3, [sc, pts3[0] * 3]);
const leader = sc.red > sc.blue ? 'Gearheads' : 'Blue Alliance';
check('after last round host offers End game', (await text(host, '[data-a="end_game"]')).includes('End game and show the winner'), '');
check('and one more round option', (await text(host, '[data-a="start_round"]')).includes('Play one more round'), '');
await host.shot('11-host-last-round-done');
await tap(host, 'end_game');
check('board shows final screen', await board.ev(`document.querySelector('#final').classList.contains('show')`), '');
check('final names leader', (await text(board, '#final .who')).includes(leader), await text(board, '#final .who'));
check('host final script', (await hostSay(host)).includes("That's the game") && (await hostSay(host)).includes(leader), await hostSay(host));
check('players see game over', (await msg(sam)).includes('Game over') && (await msg(ishan)).includes(leader), [await msg(sam), await msg(ishan)]);
await board.shot('12-board-final'); await host.shot('13-host-final');

// ---- Play again, then a tie and tiebreaker.
await host.ev(`window.confirm = () => true`);
await host.ev(`document.querySelector('[data-confirm="reset_scores"]').click()`); await wait();
sc = await scores(host);
check('play again resets scores and shows lobby', sc.red === 0 && sc.blue === 0 && await board.ev(`document.querySelector('#lobby').classList.contains('show')`) && !(await board.ev(`document.querySelector('#final').classList.contains('show')`)), sc);
check('players back to waiting', (await msg(sam)).includes('Waiting'), await msg(sam));
check('plan kept at 3 after play again', (await host.ev(`document.querySelectorAll('.slot').length`)) === 3, '');
await tap(host, 'start_round');
await tap(host, 'buzz', '"team":"red"');
await host.ev(`document.querySelector('[data-skip]').click()`); await wait(200);
await tap(host, 'control', '"team":"red"');
await tap(host, 'reveal', '"i":0');
await host.ev(`document.querySelector('#menu-open').click()`); await wait(200);
await tap(host, 'award', '"team":"red"');
const r1 = (await scores(host)).red;
// Make it tied with the score buttons (blue +10s / +5s).
await tap(host, 'adjust', '"team":"blue","delta":10');
await host.ev(`fetch('api/host',{method:'POST',body:JSON.stringify({g:'${CODE}',k:new URLSearchParams(location.search).get('k'),a:'adjust',team:'blue',delta:${r1 - 10}})})`); await wait();
const tieable = (await scores(host)).blue === r1;
await host.ev(`fetch('api/host',{method:'POST',body:JSON.stringify({g:'${CODE}',k:new URLSearchParams(location.search).get('k'),a:'plan',plan:1})})`); await wait();
if (tieable) {
  check('tie after last planned round offers tiebreaker', (await text(host, '.step')).length && (await host.ev(`document.body.textContent.includes('Tied')`)) && (await text(host, '[data-a="start_round"]')).includes('tiebreaker'), await host.ev(`document.querySelector('main').textContent.slice(0,400)`));
  await host.shot('14-host-tie');
  await tap(host, 'start_round');
  check('board labels tiebreaker', (await text(board, '#round')).startsWith('Tiebreaker'), await text(board, '#round'));
  check('host script says tiebreaker', (await hostSay(host)).toLowerCase().includes('tiebreaker'), await hostSay(host));
  await tap(host, 'buzz', '"team":"blue"');
  await host.ev(`document.querySelector('[data-skip]').click()`); await wait(200);
  await tap(host, 'control', '"team":"blue"');
  await tap(host, 'reveal', '"i":0');
  await host.ev(`document.querySelector('#menu-open').click()`); await wait(200);
  await tap(host, 'award', '"team":"blue"');
  await tap(host, 'end_game');
  check('tiebreaker winner is blue', (await text(board, '#final .who')).includes('Blue Alliance'), await text(board, '#final .who'));
} else check('could make a tie with 5-point buttons', false, r1);

// Phone reload keeps identity.
await sam.go(BASE + 'play?g=' + CODE);
check('player reload keeps buzzer view', await sam.ev(`!document.querySelector('#buzz-view').hidden`), '');
// Bad code.
const bad = await page(BASE + 'play?g=ZZZZ', 390, 844, true);
await bad.ev(`document.querySelector('#name').value='X'; document.querySelector('#join').click()`); await wait();
check('bad code shows error', (await text(bad, '#err')).includes('No game'), await text(bad, '#err'));

for (const [n, p] of [['host', host], ['board', board], ['sam', sam], ['ishan', ishan]]) check(`no JS errors on ${n}`, p.errors.length === 0, p.errors);
const fails = results.filter(r => !r[0]).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
proc.kill(); process.exit(0);
