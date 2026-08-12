# TFT Tracker

A Cloudflare Worker that polls the Riot TFT API every minute and posts results into a
Telegram chat. TypeScript, no runtime dependencies, entirely inside Cloudflare's free plan.

Tracking `audioizzzaac#98k` on Singapore (`sg2`) by default.

## What you get

```
🥇 1st of 4 teams — audioizzzaac#98K + jkyz49
Master 251 LP (+34 LP)
🧩 2 N.O.V.A. · 1 Space Groove
🎯 🟡★★Miss Fortune — Deathblade, Deathblade, Guinsoos Rageblade
    🟣★Urgot — Titans Resolve, Unstable Concoction, Quicksilver
    🟢★★Maokai — Frozen Heart, Dragons Claw
📊 Lv 7 · stage 5-3 · 56 dmg · 29g left · 33:43
```

The coloured dots are unit cost (⚪🟢🔵🟣🟡 for 1–5), matching the border
colours op.gg uses.

In Double Up the **team** standing is reported, not the raw 1–8 placement —
teammates get adjacent numbers, so a raw "2nd" is actually the winning pair's
other half. Medals only go to the top two teams, the ones that gain LP. Solo
games show the plain placement. Remakes and aborted lobbies
(`endOfGameResult` other than `GameComplete`) are recorded but not posted.

Plus a `🎮 just queued into a game` ping when a game starts.

Riot doesn't expose live board state (units, gold, HP mid-game) to third parties, so
in-progress detail isn't possible — only "in a game" plus the full post-game breakdown.

**The queue ping needs spectator access.** Development API keys get `403` on
`spectator/tft/v5`, so the Worker logs one warning, disables that call, and retries
once a day in case the key gains access later. Everything else works on a dev key.
Set `ANNOUNCE_GAME_START` to `"false"` to turn the feature off outright.

## Setup

### 1. Riot API key

Sign in at [developer.riotgames.com](https://developer.riotgames.com) and copy the
**Development API Key**. It works immediately but **expires every 24 hours**.

Rotating it means re-running `wrangler secret put`, so apply for a **Personal API Key**
(*Register Product → Personal API Key* on the same site) early. It's free and permanent;
approval takes a few days. Describe it as a personal Telegram bot posting your own TFT
match results.

### 2. Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Add the bot to your group, then send `/start@your_bot_username` there.
3. Open this in a browser, substituting your token:

   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```

   Find the `"chat"` block whose `"type"` is `"group"` or `"supergroup"`. Its `"id"` —
   negative, like `-1003742483433` — is your `TELEGRAM_CHAT_ID`.

The bot only ever calls `sendMessage`, so leave Telegram's default privacy mode **on** —
it never needs to read your group's messages. Commands addressed to it with `@` are
delivered regardless, which is all the lookup above relies on.

### 3. Cloudflare

```bash
npm install
npx wrangler login
```

Create the KV namespace that holds tracker state:

```bash
npx wrangler kv namespace create TRACKER
```

Paste the printed id into `kv_namespaces[0].id` in [wrangler.jsonc](wrangler.jsonc).

Then set the three secrets (each prompts for the value — nothing lands in git):

```bash
npx wrangler secret put RIOT_API_KEY
```

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

```bash
npx wrangler secret put TELEGRAM_CHAT_ID
```

### 4. Deploy

```bash
npx wrangler deploy
```

That's it — the cron starts firing every minute. First run posts `👀 Now tracking …`
rather than dumping recent match history.

Watch it live with `npm run tail`.

**The Worker has no public URL.** `workers_dev` and `preview_urls` are both `false` in
[wrangler.jsonc](wrangler.jsonc) — cron triggers don't need a route, and a reachable
`workers.dev` hostname would publish the status JSON (a Riot ID, the last match id, and
whether they're in a game) to anyone who scanned for it, at the cost of a KV read and an
invocation per hit. Set them back to `true` if you want it, ideally behind
[Cloudflare Access](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/),
which works on `workers.dev` without a custom domain. WAF and rate-limiting rules do not.

Note that this has to be set in the config file, not just the dashboard: disabling the
route in the Cloudflare UI alone means your next `wrangler deploy` turns it back on.

The `fetch` handler stays in [src/index.ts](src/index.ts) for `wrangler dev` — see
Local development below.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and fill in the same three secrets, then:

```bash
npm run dev
```

`wrangler dev` simulates KV locally. Fire the cron handler on demand by visiting
`http://127.0.0.1:8787/__scheduled` — nothing is written to production. The status JSON
is at `http://127.0.0.1:8787/`, which is the only place it's reachable now that the
deployed Worker has no route.

Type-check without deploying:

```bash
npm run typecheck
```

## Staying inside the free plan

Three separate limits matter, and the code is written around them:

| Limit | Free allowance | This Worker |
|---|---|---|
| Worker invocations | 100,000/day | 1,440 (once/min) |
| KV writes | **1,000/day** | only when state changes — tens/day |
| Riot API | 100 req / 2 min | 2–8 |
| CPU per invocation | 10ms | capped at 2 match fetches/run |

The KV write budget is the tight one: 1,440 cron ticks against a 1,000-write ceiling
means an unconditional write would fail on idle days alone. `runCycle` serialises state
before and after and only calls `put` when it actually differs.

The 10ms CPU cap is why `MAX_MATCHES_PER_RUN` is 2 — parsing TFT match payloads is the
expensive part, so a backlog drains over a few minutes instead of blowing the budget.
The LP baseline only advances once a backlog is fully announced, so deferred matches
still get measured against the right starting point.

## Solo vs Double Up

`TRACK_QUEUE` in [wrangler.jsonc](wrangler.jsonc) picks which ladder LP is reported from:

| Value | League queue | Match queues |
|---|---|---|
| `"solo"` | `RANKED_TFT` | 1100 |
| `"double_up"` | `RANKED_TFT_DOUBLE_UP` | 1160 |

These are completely separate ranks — someone can be Emerald in solo and Master in
Double Up at the same time. Games outside the tracked queue still get posted, just with
the queue name instead of a rank line.

Anything other than those two values is rejected at startup with an error naming the
valid ones, rather than quietly falling back to solo — a typo here would otherwise
track the wrong ladder indefinitely. `"double-up"` and `"Double Up"` also work;
`"doubleup"` does not.

**Changing this requires resetting state.** The stored LP baseline belongs to the old
ladder, so the first game after a switch would diff against the wrong number and report
a nonsense delta. Clear it:

```bash
npx wrangler kv key delete "state:v1" --binding TRACKER --remote
```

The next tick re-baselines silently and posts a fresh `👀 Now tracking` line.

## Tracking more people

Edit `PLAYERS` in [wrangler.jsonc](wrangler.jsonc) — comma-separated `Name#TAG` — and
redeploy. Each extra player adds 3 Riot requests per minute, so you have room for
roughly a dozen before the 2-minute rate limit matters. Set `ANNOUNCE_GAME_START` to
`"false"` to drop the queue pings and save a request per player per tick.

## Layout

| File | |
|---|---|
| [src/index.ts](src/index.ts) | cron handler, state diffing, error routing |
| [src/riot.ts](src/riot.ts) | Riot endpoints, cluster routing with SEA→asia fallback |
| [src/format.ts](src/format.ts) | message rendering, LP ladder math |
| [src/telegram.ts](src/telegram.ts) | sendMessage |
| [src/types.ts](src/types.ts) | Riot payload + state types |
| [wrangler.jsonc](wrangler.jsonc) | cron schedule, KV binding, non-secret vars |

## Notes

- State lives in KV under `state:v1`. Delete the key to reset; the tracker re-baselines
  silently rather than spamming old games.
- Failures never reach the chat, which carries game results only. If the Riot key expires
  the tracker goes quiet and records it in the Worker logs (`wrangler tail`) and in
  `keyAlerted` on the status page.
- LP deltas only appear when exactly one game happened between checks, since a single
  rank snapshot can't be split across two games.
