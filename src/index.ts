import { RiotClient, RiotError } from "./riot";
import { sendMessage } from "./telegram";
import {
  ALL_QUEUE_PROFILES,
  formatGameStart,
  formatResult,
  formatTracking,
  ladderPoints,
  profileForMatch,
  QUEUE_NAMES,
  resolveQueueProfile,
  type QueueProfile,
  type QueueRank,
} from "./format";
import type { Env, LeagueEntry, PlayerState, TrackerState } from "./types";

const STATE_KEY = "state:v1";

/**
 * The free plan gives 10ms CPU per invocation, and parsing a TFT match payload
 * is the expensive part. If someone played several games while we were down,
 * the backlog drains a couple per minute instead of blowing the budget.
 */
const MAX_MATCHES_PER_RUN = 2;

interface Config {
  players: string[];
  announceGameStart: boolean;
  /** Every ladder being tracked, in config order. */
  queues: QueueProfile[];
}

function readConfig(env: Env): Config {
  const missing = (["RIOT_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const).filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing secrets: ${missing.join(", ")} — set them with \`wrangler secret put\``);
  }

  const players = (env.PLAYERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!players.length) throw new Error("PLAYERS is empty — set it in wrangler.jsonc");

  // Both the default and the validation live here with the other config, not
  // in format.ts: a typo would otherwise track the wrong ladder indefinitely.
  // Comma-separated list of ladders, or "all" for every one of them.
  const names = (env.TRACK_QUEUE ?? "solo")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const queues: QueueProfile[] = [];
  for (const name of names) {
    const resolved = name.toLowerCase() === "all" ? ALL_QUEUE_PROFILES : [resolveQueueProfile(name)];
    for (const profile of resolved) {
      if (!profile) {
        throw new Error(`TRACK_QUEUE contains "${name}" — expected "all" or a list of: ${QUEUE_NAMES.join(", ")}`);
      }
      if (!queues.some((q) => q.leagueQueueType === profile.leagueQueueType)) queues.push(profile);
    }
  }
  if (!queues.length) {
    throw new Error(`TRACK_QUEUE is empty — expected "all" or a list of: ${QUEUE_NAMES.join(", ")}`);
  }

  return {
    players,
    announceGameStart: env.ANNOUNCE_GAME_START !== "false",
    queues,
  };
}

async function loadState(env: Env): Promise<TrackerState> {
  // Partial, not TrackerState: KV hands back whatever JSON is there, including
  // documents written by an older shape of this worker.
  const stored = await env.TRACKER.get<Partial<TrackerState>>(STATE_KEY, "json");
  // Build the default inline rather than spreading a shared constant: a shallow
  // spread would alias that constant's `players` map, and Workers reuse module
  // scope across invocations, so writes would leak from one cron tick into the
  // next. That only bites when KV is empty -- i.e. right after a reset.
  if (!stored) return { players: {} };
  return { ...stored, players: stored.players ?? {} };
}

async function ensurePlayer(riot: RiotClient, state: TrackerState, riotId: string): Promise<PlayerState> {
  const existing = state.players[riotId];
  if (existing?.puuid) {
    // State written by the single-queue version of this worker carried one
    // `ladder` number instead of the per-queue map. Which ladder it belonged
    // to isn't recorded, so it can't be migrated — drop it and let the first
    // game per queue skip its delta while a fresh baseline is taken.
    existing.ladders ??= {};
    delete (existing as { ladder?: unknown }).ladder;
    return existing;
  }

  const [gameName, tagLine] = riotId.split("#");
  if (!gameName || !tagLine) throw new Error(`PLAYERS entry "${riotId}" must look like Name#TAG`);

  const account = await riot.resolveAccount(gameName, tagLine);
  const player: PlayerState = {
    puuid: account.puuid,
    displayName: `${account.gameName}#${account.tagLine}`,
    seen: [],
    ladders: {},
    inGame: false,
    bootstrapped: false,
  };
  state.players[riotId] = player;
  console.log(`[resolved] ${player.displayName}`);
  return player;
}

type Send = (text: string) => Promise<void>;

/** Memoised per player per cycle — see checkPlayer. */
type EntriesFetcher = () => Promise<LeagueEntry[]>;

function entryFor(entries: LeagueEntry[], queue: QueueProfile): LeagueEntry | null {
  return entries.find((e) => e.queueType === queue.leagueQueueType) ?? null;
}

/** One rank per tracked ladder, for the messages that show them all. */
function queueRanks(cfg: Config, entries: LeagueEntry[]): QueueRank[] {
  return cfg.queues.map((q) => ({ label: q.label, entry: entryFor(entries, q) }));
}

/** Fresh LP baseline for every tracked ladder at once. */
function ladderBaselines(cfg: Config, entries: LeagueEntry[]): Record<string, number | null> {
  return Object.fromEntries(cfg.queues.map((q) => [q.leagueQueueType, ladderPoints(entryFor(entries, q))]));
}

/** Newest first, capped so the KV state document can't grow unbounded. */
function markSeen(player: PlayerState, matchId: string): void {
  player.seen = [matchId, ...player.seen].slice(0, 25);
}

/**
 * First sight of a player: record history silently rather than dumping their
 * last five games into the chat.
 */
async function bootstrapPlayer(
  cfg: Config,
  player: PlayerState,
  ids: string[],
  send: Send,
  getEntries: EntriesFetcher,
): Promise<void> {
  const entries = await getEntries();
  await send(formatTracking(player.displayName, queueRanks(cfg, entries)));
  // Commit only once the message has actually landed. Marking the player
  // bootstrapped first would mean a transient Telegram failure silently
  // consumed the announcement with no retry -- the same reason `seen` in
  // announceMatches is updated after its send rather than before.
  player.seen = ids;
  player.ladders = ladderBaselines(cfg, entries);
  player.bootstrapped = true;
}

async function announceMatches(
  riot: RiotClient,
  cfg: Config,
  player: PlayerState,
  fresh: string[],
  send: Send,
  getEntries: EntriesFetcher,
): Promise<void> {
  const batch = fresh.slice(0, MAX_MATCHES_PER_RUN);
  const entries = await getEntries();

  for (const matchId of batch) {
    const match = await riot.match(matchId);

    // A remake or aborted lobby is not a result worth posting, but it still has
    // to be recorded or we would refetch it on every tick forever.
    const outcome = match.info.endOfGameResult;
    if (outcome !== undefined && outcome !== "GameComplete") {
      console.log(`[skip] ${matchId} ended as ${outcome}`);
      markSeen(player, matchId);
      continue;
    }

    const me = match.info.participants.find((p) => p.puuid === player.puuid);
    if (!me) continue;

    // Each match reports LP from the ladder it was actually played on --
    // Solo and Double Up ranks are independent, so the right entry and the
    // right baseline both hang off the match's queue.
    const queue = profileForMatch(cfg.queues, match.info) ?? null;
    const entry = queue ? entryFor(entries, queue) : null;

    // We only hold one rank snapshot per ladder, so a clean LP delta is only
    // meaningful when exactly one game happened since the last check.
    let lpDelta: number | null = null;
    if (queue && fresh.length === 1) {
      const nowLadder = ladderPoints(entry);
      const before = player.ladders[queue.leagueQueueType];
      if (nowLadder !== null && before !== null && before !== undefined) lpDelta = nowLadder - before;
    }

    await send(
      formatResult({
        displayName: player.displayName,
        match,
        me,
        entry,
        queue,
        lpDelta,
      }),
    );
    markSeen(player, matchId);
  }

  // Only advance the LP baselines once the whole backlog has been announced,
  // so a deferred match still gets measured against the right starting point.
  if (batch.length === fresh.length) player.ladders = ladderBaselines(cfg, entries);
  player.inGame = false;
}

async function announceLiveGame(
  riot: RiotClient,
  cfg: Config,
  player: PlayerState,
  send: Send,
  getEntries: EntriesFetcher,
): Promise<void> {
  const live = await riot.isInGame(player.puuid);
  if (live === true && !player.inGame) {
    // The spectator payload doesn't say which queue was entered, so the ping
    // shows the player's rank on every tracked ladder.
    await send(formatGameStart(player.displayName, queueRanks(cfg, await getEntries())));
  }
  if (live !== null) player.inGame = live;
}

async function checkPlayer(
  riot: RiotClient,
  cfg: Config,
  state: TrackerState,
  riotId: string,
  send: Send,
): Promise<void> {
  const player = await ensurePlayer(riot, state, riotId);
  const ids = await riot.recentMatchIds(player.puuid);

  // A player who finishes a game and immediately requeues hits both the
  // match-result and game-start paths in one tick. Rank can't change between
  // two awaits milliseconds apart, so fetch it at most once per player. One
  // response carries every ladder's entry, so tracking both queues is free.
  let cached: LeagueEntry[] | undefined;
  const getEntries: EntriesFetcher = async () => {
    if (cached === undefined) {
      cached = await riot.rankedEntries(player.puuid);
    }
    return cached;
  };

  if (!player.bootstrapped) {
    await bootstrapPlayer(cfg, player, ids, send, getEntries);
    return;
  }

  const fresh = ids.filter((id) => !player.seen.includes(id)).reverse();
  if (fresh.length) await announceMatches(riot, cfg, player, fresh, send, getEntries);

  if (cfg.announceGameStart) await announceLiveGame(riot, cfg, player, send, getEntries);
}

/** How long to stop asking after the spectator endpoint refuses us. */
const SPECTATOR_RETRY_MS = 24 * 60 * 60 * 1000;

function reportPlayerError(state: TrackerState, riotId: string, err: unknown): void {
  if (err instanceof RiotError && err.isRateLimited) {
    // Nothing to gain from sleeping inside a cron invocation — the next
    // tick is a minute away, which is longer than any Riot backoff.
    console.warn(`[rate] ${err.message}`);
    return;
  }

  if (err instanceof RiotError && err.isAuthFailure) {
    // Failures stay out of the chat, which is for game results only. The flag
    // is still recorded so the status page can show that the key was rejected.
    console.error(`[auth] ${err.message} — run \`wrangler secret put RIOT_API_KEY\` with a fresh key`);
    state.keyAlerted = true;
    return;
  }

  console.error(`[${riotId}] ${(err as Error).message}`);
}

function updateSpectatorRetry(state: TrackerState, supported: boolean, now: number): void {
  if (supported) {
    if (state.spectatorRetryAt !== undefined) delete state.spectatorRetryAt;
    return;
  }

  // Arm the timer only if it isn't already running. Recomputing the deadline
  // every tick would change state every minute, which means a KV write every
  // minute -- the exact budget problem the diff check in runCycle avoids.
  if (state.spectatorRetryAt === undefined || now >= state.spectatorRetryAt) {
    state.spectatorRetryAt = now + SPECTATOR_RETRY_MS;
  }
}

export async function runCycle(env: Env): Promise<void> {
  const cfg = readConfig(env);

  const state = await loadState(env);
  const before = JSON.stringify(state);

  // A fresh client is built every invocation, so the "spectator is off" finding
  // has to be carried in KV or we'd rediscover it once a minute forever.
  const now = Date.now();
  const riot = new RiotClient(env.RIOT_API_KEY, env.RIOT_PLATFORM ?? "sg2", {
    spectatorRetryAt: state.spectatorRetryAt,
    now,
  });

  const send: Send = (text) => sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);

  for (const riotId of cfg.players) {
    try {
      await checkPlayer(riot, cfg, state, riotId, send);
      state.keyAlerted = false;
    } catch (err) {
      reportPlayerError(state, riotId, err);
    }
  }

  updateSpectatorRetry(state, riot.spectatorSupported, now);

  // KV free tier allows 1,000 writes/day and the cron fires 1,440 times, so an
  // unconditional write would blow the budget on idle days alone.
  const after = JSON.stringify(state);
  if (after !== before) await env.TRACKER.put(STATE_KEY, after);
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCycle(env).catch((err) => console.error(`[cycle] ${(err as Error).message}`)));
  },

  // Status page. Unreachable in production -- wrangler.jsonc sets workers_dev
  // and preview_urls to false, so the deployed Worker has no route at all. This
  // exists for `wrangler dev`, which also uses the separate /__scheduled route
  // to fire the cron handler on demand.
  //
  // If you ever give the Worker a public hostname again, note what this returns:
  // a Riot ID and a live "in a game" flag. It builds its response from an
  // explicit field list rather than spreading state, which is what keeps `puuid`
  // out of it -- worth preserving.
  async fetch(_req: Request, env: Env): Promise<Response> {
    const state = await loadState(env);
    const summary = Object.entries(state.players).map(([riotId, p]) => ({
      riotId,
      displayName: p.displayName,
      tracking: p.bootstrapped,
      lastMatch: p.seen[0] ?? null,
      inGame: p.inGame,
    }));

    return Response.json(
      { ok: true, keyAlerted: state.keyAlerted ?? false, players: summary },
      { headers: { "cache-control": "no-store" } },
    );
  },
};
