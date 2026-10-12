// Shared helpers for every page. All URLs are relative so the app works under any prefix.
const params = new URLSearchParams(location.search);
const CODE = (params.get('g') || '').toUpperCase();

async function post(path, body) {
  const r = await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'},
                               body: JSON.stringify(body)});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Request failed'), {status: r.status});
  return data;
}

// Long-poll the game state and call onState for each new version. Phones suspend requests
// when the screen locks, so restart the loop whenever the page becomes visible again.
function watch(onState, {key = '', onStatus = () => {}} = {}) {
  let v = 0, run = 0;
  async function loop(id) {
    while (id === run) {
      try {
        const r = await fetch(`api/state?g=${CODE}&v=${v}${key ? '&k=' + encodeURIComponent(key) : ''}`,
                              {cache: 'no-store'});
        if (id !== run) return;
        if (r.status === 404) { onStatus('missing'); await sleep(5000); continue; }
        const s = await r.json();
        onStatus('ok');
        if (s.v > v) { v = s.v; onState(s); }
      } catch (e) {
        if (id !== run) return;
        onStatus('reconnecting');
        await sleep(1500);
      }
    }
  }
  function restart() { run++; loop(run); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) restart(); });
  window.addEventListener('pageshow', e => { if (e.persisted) restart(); });
  window.addEventListener('online', restart);
  restart();
  return {refresh: () => { v = 0; restart(); }};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

// The public join address, shown on the board and in the host script.
function joinURL() {
  const base = location.host + location.pathname.replace(/[^/]*$/, '');
  return base.replace(/\/$/, '');
}
