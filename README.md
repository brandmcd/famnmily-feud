# FAMNMily Feud

A Family Feud game for a room full of people: a projector board, a host controller on the host's phone, and buzzers on everyone else's phones. Built for a social event of FAMNM, the FIRST Alumni and Mentors Network at the University of Michigan. The red and blue teams are FIRST alliances.

There is no build step and no dependencies beyond Python 3.10+ (standard library only).

## Screens

| Page | Who uses it |
|---|---|
| `/` | Landing page: join with a code, host a game, or open a board |
| `/host?g=CODE&k=KEY` | The host's phone. Shows what to say, the answers to reveal, strikes, and the next step. The key in the link is what lets you run the game. |
| `/board?g=CODE` | The projector. Click once to turn on sound and full screen. Never receives hidden answers. |
| `/play?g=CODE` | A player's buzzer. The whole screen changes color with the game state. |
| `/admin` | Edit questions, answers, points and the "we surveyed N people" count. Needs the admin key. |

## Running it

```
python3 server.py
```

It listens on `127.0.0.1:8098` (set `FEUD_PORT` to change it). Put it behind a reverse proxy for phones to reach it; `deploy/nginx-location.conf` serves it under `/famnmily-feud/` and `deploy/famnmily-feud.service` is a systemd unit. Every page and API call uses relative URLs, so any path prefix works.

## Questions and answers

Survey answers are the whole game, so they are not in this repository. The server keeps them in `data/questions.json`, which is gitignored along with saved games.

On first start the server seeds `data/questions.json` from, in order:

1. `data/board.csv` (or the file named by `FEUD_BOARD_CSV`), a survey tally with columns `Question, Rank, Answer, Votes` and optionally `Points` and `Surveyed`. Without `Points`, each answer scores its share of the votes listed. With `Surveyed`, the host reads that number out and points stay a share of everyone asked, even when rare answers were left off the board. Up to 8 answers per question are kept.
2. `questions.example.json`, three made-up questions so the game runs out of the box.

After that, edit questions on the `/admin` page. "Re-import from survey" on that page replaces everything with a fresh read of the CSV.

The admin key is read from `/etc/famnmily-feud/admin.key` (or `FEUD_ADMIN_KEY_FILE`). Without that file the admin page stays locked.

The host screen shows every answer, so hosting starts out locked: "Start a new game" asks for the admin key. Unlock it on the admin page if you want anyone with the link to be able to host. The setting lives in `data/settings.json`.

## Logos

`static/img/` holds the FAMNM logo files. The game uses `full-white.png`; swap it for your own logo to reuse the game.

## How a game runs

The host picks how many rounds to play and can change the question and points for each round. By default points go single, then double, with triple for the last round. Each round is a face-off (the app works out who won it from the answers the host taps), then play or pass, then the playing alliance answers down the line until it clears the board or gets three strikes, and the other alliance gets one answer to steal. After the last round the host ends the game and the board shows the final score; a tie offers a tiebreaker round.

## Tests

`tests/browser-game.js` plays complete games in headless Chromium with the host, the board and two player phones open at once, and checks every screen after each step. It needs [Bun](https://bun.sh) and Chromium and a running server:

```
ADMIN_KEY=your-admin-key bun tests/browser-game.js http://127.0.0.1:8098/
```

## Sounds

The sound effects in `static/sfx/` are CC0 recordings from Freesound; `static/sfx/CREDITS.md` lists each source.

## License

MIT, see `LICENSE`. Roboto is under the Apache License 2.0.
