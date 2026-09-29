# kolaru

Render web service deployment setup for the Discord voice bot host.

- Dashboard: `/` — add tokens (one or bulk), voice control, loud audio player, bot list
- Token file: `/token-file` — add tokens, or edit `tokens.txt` directly
- Mic routing: `/mic-route` — capture the browser mic and route it per account

## Choosing a voice channel

Don't type channel ids by hand. The dashboard has a **channel picker**: pick an
account, press *Load channels*, and it lists that account's servers and voice
channels straight from Discord. *Use selected* fills the id in for you.

This matters because the two failure modes look identical from the outside but
mean opposite things:

- **`Missing Access`** (403) — the account is **not in that server**. It cannot
  join no matter how many times you retry; add the account to the server first.
- **`Unknown Channel`** (404) — the id is wrong.

With 30 accounts you will usually have a mix of both: the ones that are in the
server connect, the rest fail with the reason shown next to each account under
*Accounts*. Only accounts that actually connected will hear the music or the mic,
which is why the mic looks "not working" when most of them failed the join.

A join now runs in batches of 5 (Discord rate-limits, and 30 accounts serially
takes minutes) and logs one summary line instead of three lines per account.

## Adding tokens

Tokens live in a text file (`tokens.txt` by default, override with `TOKENS_FILE`),
one per line. Three ways to get them in, all writing the same file:

- **Dashboard → Token Manager**: paste a single token, or paste a whole list into
  the bulk box (Enter submits)
- **`/token-file` page**: add one, add a bulk list, or edit the file directly in a
  textarea and save (Ctrl+S)
- **The file itself**: write it on disk and save — the server watches it

In every case the file is the source of truth, so the dashboard, the file page and
the file on disk never disagree. Adding writes the file and logs the new accounts
in immediately; blank lines and lines starting with `#`, `;` or `//` are ignored and
duplicates are dropped. Rewriting the file from the page logs removed accounts out.

`POST /tokens/add` returns `410` on purpose: use `/api/tokens/append` (which writes
the file) instead.

**Set `TOKEN_FILE_KEY` on Render.** The file endpoints read and write real tokens, so
without a key anyone who finds your dashboard URL can read every token and add
accounts. The page prompts for the key once and keeps it for the tab.

⚠️ On Render's free plan the filesystem is wiped on every deploy, so a file saved
from the browser disappears on the next release. For tokens that survive redeploys,
either commit `tokens.txt` (it is gitignored, so force-add it in a private repo) or
keep using the `BOT_TOKENS` env var, which is written into the file once at startup.

## Louder audio

Old behaviour was a single `volume=N` ffmpeg pass, which just clips past ~1.0.
Audio now runs through a float PCM mixer and a proper chain:

1. **Volume (pre-gain)** (0.5–100, default 12) — the loudness knob. Applied in
   float, so a high multiplier cannot clip on its own
2. **Drive** (0–100, default 40) — `acompressor` with makeup gain. Character, not
   level: it squeezes peaks so more of the track sits near the ceiling
3. **Target LUFS** (optional) — `loudnorm` pass, e.g. `-9`, for a guaranteed level
4. **Limiter** (on by default) — `alimiter` holding the peak at 0.95, so no
   combination of the above can ever clip

The mixer is 32-bit float and ffmpeg converts to Int16 only at the very end.
That detail matters: with Int16 the gain wrapped and flattened the signal before
the compressor ever saw it, which is why every control except volume sounded
identical. Measured with real ffmpeg on the same input:

| Setting | RMS | Peak |
| --- | --- | --- |
| volume 1, no drive, no limiter | −24.9 dBFS | 3277 |
| volume 12, no drive, no limiter | −4.0 dBFS | 32768 (clips, as expected) |
| volume 12 + limiter | −5.4 dBFS | 31130 (held at 0.95) |
| volume 12 + drive 40 + limiter | −5.7 dBFS | 31130 |
| volume 12 + drive 40 + −9 LUFS | −11.4 dBFS | 23997 |

Music is also ducked automatically while the mic is live. All of it is editable
on the dashboard or via `POST /audio/loudness`.

## Mic routing

`/mic-route` captures the browser mic (echo cancellation, noise suppression and
auto gain off), resamples to 48 kHz mono with an AudioWorklet and streams 20 ms PCM
frames over a WebSocket to `/mic/stream`. The server mixes them into per-account buses:

| Route | What the account hears |
| --- | --- |
| `mix` | music + mic (default) |
| `music` | music only |
| `mic` | mic only |
| `off` | nothing (unsubscribed) |

Set the default with `MIC_ROUTE_DEFAULT` or per account from the routing table.
Music is decoded once and fanned out, so every account stays in sync.

Playback is throttled in software, not by ffmpeg. ffmpeg decodes a three-minute
track in about a second, so after every chunk the server checks how far ahead the
mixers are and pauses the decoder until they catch up (300 ms ahead = pause,
100 ms = resume). The mixers buffer 600 ms, so nothing is ever dropped and
nothing is ever buffered beyond a few hundred kB.

Measured on a 3-minute file: 112 ms from *Play* to the first sample, 0% silent
blocks over 12 s, memory flat. An earlier version buffered the decoded track in
memory instead, which meant ~8 GB of copying per track - that was the delay, and
on a small container it got the process throttled or killed, which surfaced as
`ffmpeg exited with code 255`.

## Logging

Discord re-emits `stateChange` on every heartbeat, which used to bury the log in
`ready -> ready` spam, and the per-keepalive "still active" line fired every 15 s
per account. Both are now quiet: real transitions only, and one line per account
per hour. When ffmpeg cannot decode a file, the reason from its stderr is included
in the error rather than a bare exit code.

## Render configuration

Use these values in Render:

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variables:
  - `HOST=0.0.0.0`
  - `PORT=10000`
  - `TOKENS_FILE=tokens.txt`
  - `MAX_BOTS=0` (0 = unlimited)
  - `AUDIO_VOLUME=12`, `AUDIO_DRIVE=40`, `AUDIO_LIMITER=true`
  - `MIC_GAIN=6`, `MIC_ROUTE_DEFAULT=mix`
  - `VOICE_CHANNEL_IDS=your-channel-id-here` (only needed with `AUTO_JOIN=true`)

## HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | dashboard |
| GET | `/token-file` | token file page |
| GET | `/mic-route` | mic routing page |
| GET | `/mic-worklet.js` | AudioWorklet used by the mic page |
| GET | `/health`, `/status`, `/settings` | health, bot status, full settings |
| GET | `/tokens` | masked token list (raw tokens are never served here) |
| GET | `/api/tokens/file` | raw file content — needs `TOKEN_FILE_KEY` if set |
| POST | `/api/tokens/append` | add one or many tokens to the file |
| POST | `/api/tokens/save` | replace the file with the pasted content |
| POST | `/tokens/reload` | re-read the token file |
| POST | `/tokens/delete` | remove a token **from the file** |
| GET | `/channels` | voice channels visible to an account (`?index=N`) |
| POST | `/join`, `/stay`, `/leave` | voice channel control |
| POST | `/audio/upload`, `/audio/play`, `/audio/stop` | music player |
| POST | `/audio/loudness` | volume / drive / LUFS / limiter / ducking |
| POST | `/audio/mute`, `/audio/unmute`, `/audio/deafen`, `/audio/undeafen` | voice flags |
| WS | `/mic/stream` | mic PCM stream |
| GET | `/mic/status` | mic client + packet counters |
| POST | `/mic/routing`, `/mic/stop` | routing, drop mic clients |

## Tests

```
npm test
```

Covers the token file parser, the PCM mixer, the loudness filter builder, the
inline page scripts, and a full server smoke test (fake Discord client + fake
ffmpeg) that streams mic audio over a real WebSocket and checks the routing.

## Notes

- `ffmpeg-static` provides ffmpeg; override with `FFMPEG_PATH` if you want your own.
- This project drives user accounts through `discord.js-selfbot-v13`, which is
  against the Discord Terms of Service and the most common cause of account bans.
  Use it on accounts you are willing to lose, and prefer real bot tokens.

