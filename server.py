"""FAMNMily Feud: a Family Feud game with a projector board, a phone host and phone buzzers.

Serves static pages from ./static and a small JSON API. Every page sits at the top level
and takes the game code as ?g=CODE, so the app works under any path prefix
(nginx strips /famnmily-feud/ before proxying here).

State lives in memory and is saved to data/games.json after every change. Clients
long-poll GET api/state?g=CODE&v=N, which returns as soon as the game's version passes N.
"""
import csv
import json
import os
import random
import secrets
import threading
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, 'static')
SAVE = os.path.join(ROOT, 'data', 'games.json')
# Optional survey board used to seed data/questions.json the first time (see README).
BOARD_CSV = os.environ.get('FEUD_BOARD_CSV', os.path.join(ROOT, 'data', 'board.csv'))
PORT = int(os.environ.get('FEUD_PORT', '8098'))
QUESTIONS = os.environ.get('FEUD_QUESTIONS', os.path.join(ROOT, 'data', 'questions.json'))
EXAMPLE = os.path.join(ROOT, 'questions.example.json')
SETTINGS = os.path.join(ROOT, 'data', 'settings.json')
ADMIN_KEY_FILE = os.environ.get('FEUD_ADMIN_KEY_FILE', '/etc/famnmily-feud/admin.key')
MAX_ANSWERS = 8
POLL_SECONDS = float(os.environ.get('FEUD_POLL_SECONDS', '25'))
EXPIRE_SECONDS = 24 * 3600
CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'
DEFAULT_ROUNDS = 4

lock = threading.Condition()
games = {}

TYPES = {'.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
         '.png': 'image/png', '.mp3': 'audio/mpeg', '.md': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'}


def read_survey_csv(path):
    """Turn a survey board (Question, Rank, Answer, Votes, and optionally Points and Surveyed) into
    question records. Without a Points column, points are each answer's share of the votes listed;
    with Surveyed, they stay a share of everyone asked even when rare answers were left out."""
    qs = {}
    with open(path, newline='') as f:
        for row in csv.DictReader(f):
            q = qs.setdefault(row['Question'], {'title': row['Question'], 'answers': [], 'surveyed': 0})
            q['answers'].append({'text': row['Answer'], 'votes': int(row['Votes']),
                                 'points': int(row['Points']) if row.get('Points') else None})
            q['surveyed'] = int(row['Surveyed']) if row.get('Surveyed') else q['surveyed'] + int(row['Votes'])
    out = []
    for i, q in enumerate(qs.values()):
        q['answers'].sort(key=lambda a: -a['votes'])
        q['answers'] = [{'text': a['text'], 'points': a['points'] if a['points'] is not None else round(100 * a['votes'] / q['surveyed'])}
                        for a in q['answers'][:MAX_ANSWERS]]
        out.append({'id': f'q{i + 1}', 'enabled': True, **q})
    return out


def load_store():
    """The editable question set. Seeded once from the survey CSV (or the bundled example) and
    from then on changed only through the admin page."""
    try:
        with open(QUESTIONS) as f:
            return json.load(f)['questions']
    except (OSError, ValueError, KeyError):
        pass
    if os.path.exists(BOARD_CSV):
        qs = read_survey_csv(BOARD_CSV)
    else:
        with open(EXAMPLE) as f:
            qs = json.load(f)['questions']
    save_store(qs)
    return qs


def save_store(qs):
    tmp = QUESTIONS + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'questions': qs}, f, indent=1)
    os.replace(tmp, QUESTIONS)


def clean_questions(raw):
    """Validate questions sent from the admin page."""
    out = []
    for i, q in enumerate(raw):
        title = str(q.get('title', '')).strip()[:200]
        answers = [{'text': str(a.get('text', '')).strip()[:60], 'points': max(0, min(100, int(a.get('points', 0))))}
                   for a in q.get('answers', []) if str(a.get('text', '')).strip()][:MAX_ANSWERS]
        if not title:
            continue
        answers.sort(key=lambda a: -a['points'])
        out.append({'id': str(q.get('id') or f'n{i}')[:20], 'title': title, 'enabled': bool(q.get('enabled', True)),
                    'surveyed': max(0, int(q.get('surveyed', 0))), 'answers': answers})
    return out


def load_questions():
    """Questions for a new game: enabled ones with at least two answers."""
    return [{'title': q['title'], 'n': q['surveyed'], 'answers': q['answers']}
            for q in load_store() if q.get('enabled', True) and len(q['answers']) >= 2]


def hosting_locked():
    """While locked, starting a game needs the admin key, so nobody can open a host screen
    (which shows every answer) before the event."""
    try:
        with open(SETTINGS) as f:
            return bool(json.load(f).get('locked', True))
    except (OSError, ValueError):
        return True


def set_locked(locked):
    with open(SETTINGS, 'w') as f:
        json.dump({'locked': bool(locked)}, f)


def admin_key():
    try:
        with open(ADMIN_KEY_FILE) as f:
            return f.read().strip()
    except OSError:
        return ''


def new_game():
    while True:
        code = ''.join(random.choice(CODE_LETTERS) for _ in range(4))
        if code not in games:
            break
    qs = load_questions()
    g = {
        'code': code, 'key': secrets.token_urlsafe(9), 'created': time.time(), 'v': 1,
        'questions': qs, 'used': [], 'qi': None,
        'surveyed': max((q['n'] for q in qs), default=0),
        'teams': {'red': {'name': 'Red Alliance', 'score': 0}, 'blue': {'name': 'Blue Alliance', 'score': 0}},
        'phase': 'lobby', 'round': 0, 'mult': 1, 'revealed': [], 'strikes': 0, 'bank': 0,
        'control': None, 'buzz': None, 'flash': None, 'winner': None, 'players': {},
        'plan': DEFAULT_ROUNDS, 'final': None,
    }
    fill_lineup(g)
    games[code] = g
    return g


def other(team):
    return 'blue' if team == 'red' else 'red'


def mult_for(rnd, plan):
    """Recommended points: single early, double past halfway, triple for the last planned round.
    Rounds past the plan are tiebreakers and stay single."""
    if rnd == plan:
        return 3
    if plan / 2 < rnd < plan:
        return 2
    return 1


def quality(g, i):
    """How likely a question is to make a good board: at least four answers, then a clear top answer."""
    a = g['questions'][i]['answers']
    return (len(a) >= 4, a[0]['points'] if a else 0)


def fill_lineup(g):
    """Keep one lineup slot per planned round. New slots get the best question not yet played or
    lined up; slots the host has not customized get the recommended points for their round."""
    plan, lu = g.get('plan', DEFAULT_ROUNDS), g.setdefault('lineup', [])
    del lu[max(plan, g['round']):]
    taken = {x['qi'] for x in lu} | set(g['used'])
    while len(lu) < plan:
        left = [i for i in range(len(g['questions'])) if i not in taken]
        if not left:
            break
        qi = max(left, key=lambda i: quality(g, i))
        taken.add(qi)
        lu.append({'qi': qi, 'mult': 1, 'custom': False})
    for r, x in enumerate(lu, 1):
        if not x.get('custom'):
            x['mult'] = mult_for(r, plan)


def recommend(g):
    """What the next round should be: its lineup slot, or for extra rounds the best unplayed question."""
    nxt = g['round'] + 1
    lu = g.get('lineup') or []
    if nxt <= len(lu) and lu[nxt - 1]['qi'] not in g['used']:
        return {'qi': lu[nxt - 1]['qi'], 'mult': lu[nxt - 1]['mult'], 'round': nxt}
    left = [i for i in range(len(g['questions'])) if i not in g['used']]
    if not left:
        return None
    return {'qi': max(left, key=lambda i: quality(g, i)), 'mult': 1, 'round': nxt}


def public_state(g, host=False):
    """The board and buzzers never receive hidden answers; only the host does."""
    q = g['questions'][g['qi']] if g['qi'] is not None else None
    s = {k: g[k] for k in ('code', 'v', 'teams', 'phase', 'round', 'mult', 'strikes', 'bank',
                           'control', 'buzz', 'flash', 'winner', 'surveyed')}
    s['plan'] = g.get('plan', DEFAULT_ROUNDS)
    s['final'] = g.get('final')
    s['fo'] = g.get('fo')
    s['players'] = len(g['players'])
    if q:
        s['question'] = {'title': q['title'], 'n': q['n'], 'count': len(q['answers']),
                         'answers': [a if (host or g['revealed'][i]) else None for i, a in enumerate(q['answers'])]}
        s['revealed'] = g['revealed']
    if host:
        s['key'] = g['key']
        s['questions'] = [{'title': x['title'], 'n': x['n'], 'count': len(x['answers']),
                           'top': x['answers'][0]['points'] if x['answers'] else 0} for x in g['questions']]
        s['used'] = g['used']
        s['qi'] = g['qi']
        s['recommend'] = recommend(g)
        if 'lineup' not in g:
            fill_lineup(g)
        s['lineup'] = g['lineup']
    return s


def flash(g, kind, **extra):
    g['flash'] = dict(kind=kind, id=g['v'] + 1, **extra)


def host_action(g, a, body):
    if 'lineup' not in g:
        fill_lineup(g)
    q = g['questions'][g['qi']] if g['qi'] is not None else None
    if a == 'start_round':
        rec = recommend(g)
        qi = int(body['qi']) if body.get('qi') is not None else rec['qi']
        if 'mult' not in body and rec:
            body['mult'] = rec['mult']
        g['qi'] = qi
        if qi not in g['used']:
            g['used'].append(qi)
        g['round'] += 1
        g['revealed'] = [False] * len(g['questions'][qi]['answers'])
        g.update(phase='faceoff', strikes=0, bank=0, control=None, buzz=None, winner=None, final=None, fo=None)
        g['mult'] = int(body.get('mult', g['mult']))
        flash(g, 'round')
    elif a == 'reveal' and q:
        i = int(body['i'])
        if not g['revealed'][i]:
            g['revealed'][i] = True
            if g['phase'] in ('faceoff', 'play', 'steal'):
                g['bank'] += q['answers'][i]['points'] * g['mult']
            flash(g, 'reveal', i=i)
            if g['phase'] == 'faceoff':
                fo_pick(g, i)
            # Clearing the board during play wins the round for the team in control.
            if g['phase'] == 'play' and all(g['revealed']):
                award(g, g['control'])
    elif a == 'hide' and q:
        i = int(body['i'])
        fo = g.get('fo')
        if fo:
            # Undo a face-off answer: that alliance answers again.
            for t, v in list(fo['picks'].items()):
                if v == i:
                    del fo['picks'][t]
                    fo.update(turn=t, winner=None, retry=False)
        if g['revealed'][i]:
            g['revealed'][i] = False
            if g['phase'] in ('faceoff', 'play', 'steal'):
                g['bank'] = max(0, g['bank'] - q['answers'][i]['points'] * g['mult'])
    elif a == 'strike':
        if g['phase'] == 'faceoff':
            fo_pick(g, -1)
        if g['phase'] == 'play':
            g['strikes'] = min(3, g['strikes'] + 1)
            if g['strikes'] == 3:
                g['phase'] = 'steal'
        flash(g, 'strike', n=g['strikes'] if g['phase'] in ('play', 'steal') else 1)
    elif a == 'unstrike':
        g['strikes'] = max(0, g['strikes'] - 1)
        if g['phase'] == 'steal':
            g['phase'] = 'play'
    elif a == 'control':
        g['control'] = body['team']
        g['phase'] = 'play'
        g['buzz'] = None
        g['fo'] = None
    elif a == 'steal':
        # A successful steal takes the whole bank; a failed one gives it to the team in control.
        award(g, other(g['control']) if body.get('ok') else g['control'])
    elif a == 'award':
        award(g, body['team'])
    elif a == 'reveal_all' and q:
        g['revealed'] = [True] * len(q['answers'])
        flash(g, 'reveal', i=-1)
    elif a == 'buzz':
        g['buzz'] = {'team': body['team'], 'name': g['teams'][body['team']]['name'], 't': time.time()}
        g['fo'] = {'turn': body['team'], 'picks': {}}
        flash(g, 'buzz')
    elif a == 'clear_buzz':
        g['buzz'] = None
        g['fo'] = None
    elif a == 'mult':
        g['mult'] = int(body['mult'])
    elif a == 'adjust':
        t = g['teams'][body['team']]
        t['score'] = max(0, t['score'] + int(body['delta']))
    elif a == 'rename':
        g['teams'][body['team']]['name'] = str(body['name'])[:30] or g['teams'][body['team']]['name']
    elif a == 'lobby':
        g['phase'] = 'lobby'
    elif a == 'plan':
        g['plan'] = max(1, min(10, int(body['plan'])))
        fill_lineup(g)
    elif a == 'lineup':
        # Set one round's question and/or points. Picking a question already in another slot swaps them.
        lu = g['lineup']
        r = int(body['r'])
        if not 0 <= r < len(lu):
            raise ValueError('no such round')
        if body.get('qi') is not None:
            qi = int(body['qi'])
            if not 0 <= qi < len(g['questions']):
                raise ValueError('no such question')
            for x in lu:
                if x['qi'] == qi:
                    x['qi'] = lu[r]['qi']
            lu[r]['qi'] = qi
        if body.get('mult') is not None:
            lu[r]['mult'] = max(1, min(3, int(body['mult'])))
            lu[r]['custom'] = True
    elif a == 'end_game':
        r, b = g['teams']['red']['score'], g['teams']['blue']['score']
        g['final'] = {'team': None if r == b else ('red' if r > b else 'blue'), 'red': r, 'blue': b}
        g['phase'] = 'over'
        flash(g, 'over')
    elif a == 'reset_scores':
        for t in g['teams'].values():
            t['score'] = 0
        g.update(round=0, qi=None, phase='lobby', bank=0, strikes=0, winner=None, final=None,
                 control=None, buzz=None, fo=None, lineup=[])
        fill_lineup(g)
    else:
        raise ValueError('unknown action')


def fo_pick(g, i):
    """Record a face-off answer for the alliance whose turn it is (i = answer index, -1 = not on
    the board) and work out who wins: the #1 answer wins at once, otherwise the higher-ranked of
    the two answers wins, and two misses mean buzz again."""
    fo = g.get('fo')
    if not fo or fo.get('winner') or fo.get('retry'):
        return
    t = fo['turn']
    fo['picks'][t] = i
    if i == 0:
        fo['winner'] = t
    elif other(t) not in fo['picks']:
        fo['turn'] = other(t)
    else:
        hits = {k: v for k, v in fo['picks'].items() if v >= 0}
        if hits:
            fo['winner'] = min(hits, key=hits.get)
        else:
            fo['retry'] = True


def award(g, team):
    g['teams'][team]['score'] += g['bank']
    g['winner'] = {'team': team, 'points': g['bank']}
    g['bank'] = 0
    g['phase'] = 'done'
    flash(g, 'win', team=team)


def player_action(g, a, body):
    if a == 'join':
        pid = secrets.token_urlsafe(6)
        team = body['team'] if body.get('team') in ('red', 'blue') else 'red'
        g['players'][pid] = {'name': str(body.get('name', '')).strip()[:20] or 'Player', 'team': team}
        return {'pid': pid}
    p = g['players'].get(body.get('pid'))
    if not p:
        raise KeyError('rejoin')
    if a == 'buzz':
        if g['phase'] == 'faceoff' and g['buzz'] is None:
            g['buzz'] = {'team': p['team'], 'name': p['name'], 't': time.time()}
            g['fo'] = {'turn': p['team'], 'picks': {}}
            flash(g, 'buzz')
            return {'first': True, 't': g['buzz']['t']}
        return {'first': False}
    if a == 'switch':
        p['team'] = other(p['team'])
        return {'team': p['team']}
    raise ValueError('unknown action')


def save():
    tmp = SAVE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(games, f)
    os.replace(tmp, SAVE)


def load():
    try:
        with open(SAVE) as f:
            games.update(json.load(f))
    except (OSError, ValueError):
        pass


def expire():
    now = time.time()
    for code in [c for c, g in games.items() if now - g['created'] > EXPIRE_SECONDS]:
        del games[code]


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype='application/json', cache='no-store'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', cache)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(u.query).items()}
        path = u.path.rstrip('/') or '/index'
        if path == '/api/state':
            return self.state(qs)
        if path == '/api/admin/questions':
            if not self.is_admin():
                return self.send(403, {'error': 'Wrong admin key.'})
            with lock:
                return self.send(200, {'questions': load_store(), 'locked': hosting_locked()})
        name = path.lstrip('/')
        if '.' not in name:
            name += '.html'
        full = os.path.normpath(os.path.join(STATIC, name))
        if not full.startswith(STATIC) or not os.path.isfile(full):
            return self.send(404, b'not found', 'text/plain')
        with open(full, 'rb') as f:
            data = f.read()
        ext = os.path.splitext(full)[1]
        self.send(200, data, TYPES.get(ext, 'application/octet-stream'),
                  'no-cache' if ext in ('.html', '.js', '.css') else 'public, max-age=86400')

    def state(self, qs):
        code = qs.get('g', '').upper()
        since = int(qs.get('v', '0') or 0)
        deadline = time.time() + POLL_SECONDS
        with lock:
            while True:
                g = games.get(code)
                if not g:
                    return self.send(404, {'error': 'No game with that code.'})
                if g['v'] > since or time.time() >= deadline:
                    host = qs.get('k') == g['key']
                    return self.send(200, public_state(g, host))
                lock.wait(max(0.1, deadline - time.time()))

    def is_admin(self):
        key = admin_key()
        return bool(key) and secrets.compare_digest(self.headers.get('X-Admin-Key', ''), key)

    def do_POST(self):
        u = urlparse(self.path)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0) or 0)) or b'{}')
        except ValueError:
            return self.send(400, {'error': 'bad json'})
        if u.path.startswith('/api/admin/'):
            if not self.is_admin():
                return self.send(403, {'error': 'Wrong admin key.'})
            with lock:
                try:
                    if u.path == '/api/admin/questions':
                        qs = clean_questions(body.get('questions', []))
                    elif u.path == '/api/admin/import':
                        qs = read_survey_csv(BOARD_CSV)
                    elif u.path == '/api/admin/lock':
                        set_locked(body.get('locked', True))
                        return self.send(200, {'locked': hosting_locked()})
                    else:
                        return self.send(404, {'error': 'not found'})
                except (OSError, ValueError, TypeError, KeyError) as e:
                    return self.send(400, {'error': f'Could not save: {e}'})
                save_store(qs)
                return self.send(200, {'questions': qs})
        with lock:
            expire()
            if u.path == '/api/create':
                key = admin_key()
                if hosting_locked() and not (key and secrets.compare_digest(str(body.get('admin', '')), key)):
                    return self.send(403, {'error': 'Hosting is locked. Enter the host password.', 'locked': True})
                try:
                    g = new_game()
                except OSError:
                    return self.send(500, {'error': 'Survey results are missing on the server.'})
                g['v'] += 1
                save()
                return self.send(200, {'code': g['code'], 'key': g['key']})
            g = games.get(str(body.get('g', '')).upper())
            if not g:
                return self.send(404, {'error': 'No game with that code.'})
            try:
                if u.path == '/api/host':
                    if body.get('k') != g['key']:
                        return self.send(403, {'error': 'Not the host.'})
                    host_action(g, body.get('a'), body)
                    out = {'ok': True}
                elif u.path == '/api/player':
                    out = player_action(g, body.get('a'), body)
                else:
                    return self.send(404, {'error': 'not found'})
            except KeyError as e:
                return self.send(409, {'error': str(e)})
            except (ValueError, IndexError, TypeError):
                return self.send(400, {'error': 'bad request'})
            g['v'] += 1
            save()
            lock.notify_all()
        return self.send(200, out)


if __name__ == '__main__':
    os.makedirs(os.path.dirname(SAVE), exist_ok=True)
    load()
    ThreadingHTTPServer.daemon_threads = True
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'FAMNMily Feud on 127.0.0.1:{PORT}, {len(load_store())} questions in {QUESTIONS}', flush=True)
    srv.serve_forever()
