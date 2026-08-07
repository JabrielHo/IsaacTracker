import { RiotClient, RiotError } from "./riot";
import { sendMessage } from "./telegram";
import {
  formatGameStart,
  formatResult,
  isTrackedQueue,
  ladderPoints,
  QUEUE_NAMES,
  rankLabel,
  resolveQueueProfile,
  type QueueProfile,
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
  queue: QueueProfile;
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

  // Validated here with the other config rather than defaulted silently in
  // format.ts: a typo would otherwise track the wrong ladder indefinitely.
  const queue = resolveQueueProfile(env.TRACK_QUEUE);
  if (!queue) {
    throw new Error(`TRACK_QUEUE is "${env.TRACK_QUEUE}" — expected one of: ${QUEUE_NAMES.join(", ")}`);
  }

  return {
    players,
    announceGameStart: env.ANNOUNCE_GAME_START !== "false",
    queue,
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
  if (existing?.puuid) return existing;

  const [gameName, tagLine] = riotId.split("#");
  if (!gameName || !tagLine) throw new Error(`PLAYERS entry "${riotId}" must look like Name#TAG`);

  const account = await riot.resolveAccount(gameName, tagLine);
  const player: PlayerState = {
    puuid: account.puuid,
    displayName: `${account.gameName}#${account.tagLine}`,
    seen: [],
    ladder: null,
    inGame: false,
    bootstrapped: false,
  };
  state.players[riotId] = player;
  console.log(`[resolved] ${player.displayName}`);
  return player;
}

type Send = (text: string) => Promise<void>;

/** Memoised per player per cycle — see checkPlayer. */
type EntryFetcher = () => Promise<LeagueEntry | null>;

function sender(env: Env): Send {
  return (text) => sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
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
  getEntry: EntryFetcher,
): Promise<void> {
  const entry = await getEntry();
  await send(`👀 Now tracking <b>${player.displayName}</b> — ${rankLabel(entry)} (${cfg.queue.label})`);
  // Commit only once the message has actually landed. Marking the player
  // bootstrapped first would mean a transient Telegram failure silently
  // consumed the announcement with no retry -- the same reason `seen` in
  // announceMatches is updated after its send rather than before.
  player.seen = ids;
  player.ladder = ladderPoints(entry);
  player.bootstrapped = true;
}

async function announceMatches(
  riot: RiotClient,
  cfg: Config,
  player: PlayerState,
  fresh: string[],
  send: Send,
  getEntry: EntryFetcher,
): Promise<void> {
  const batch = fresh.slice(0, MAX_MATCHES_PER_RUN);
  const entry = await getEntry();
  const nowLadder = ladderPoints(entry);

  // We only hold one rank snapshot, so a clean LP delta is only meaningful
  // when exactly one game happened since the last check.
  const delta = fresh.length === 1 && player.ladder !== null && nowLadder !== null ? nowLadder - player.ladder : null;

  for (const matchId of batch) {
    const match = await riot.match(matchId);

    // A remake or aborted lobby is not a result worth posting, but it still has
    // to be recorded or we would refetch it on every tick forever.
    const outcome = match.info.endOfGameResult;
    if (outcome !== undefined && outcome !== "GameComplete") {
      console.log(`[skip] ${matchId} ended as ${outcome}`);
      player.seen = [matchId, ...player.seen].slice(0, 25);
      continue;
    }

    const me = match.info.participants.find((p) => p.puuid === player.puuid);
    if (!me) continue;

    await send(
      formatResult({
        displayName: player.displayName,
        match,
        me,
        rankEntry: isTrackedQueue(match.info, cfg.queue) ? entry : null,
        lpDelta: delta,
      }),
    );
    player.seen = [matchId, ...player.seen].slice(0, 25);
  }

  // Only advance the LP baseline once the whole backlog has been announced,
  // so a deferred match still gets measured against the right starting point.
  if (batch.length === fresh.length) player.ladder = nowLadder;
  player.inGame = false;
}

async function announceLiveGame(
  riot: RiotClient,
  player: PlayerState,
  send: Send,
  getEntry: EntryFetcher,
): Promise<void> {
  const live = await riot.isInGame(player.puuid);
  if (live === true && !player.inGame) {
    await send(formatGameStart(player.displayName, await getEntry()));
  }
  if (live !== null) player.inGame = live;
}

async function checkPlayer(
  riot: RiotClient,
  env: Env,
  cfg: Config,
  state: TrackerState,
  riotId: string,
): Promise<void> {
  const send = sender(env);

  const player = await ensurePlayer(riot, state, riotId);
  const ids = await riot.recentMatchIds(player.puuid, 5);

  // A player who finishes a game and immediately requeues hits both the
  // match-result and game-start paths in one tick. Rank can't change between
  // two awaits milliseconds apart, so fetch it at most once per player.
  let cached: LeagueEntry | null | undefined;
  const getEntry: EntryFetcher = async () => {
    if (cached === undefined) {
      cached = await riot.rankedEntry(player.puuid, cfg.queue.leagueQueueType);
    }
    return cached;
  };

  if (!player.bootstrapped) {
    await bootstrapPlayer(cfg, player, ids, send, getEntry);
    return;
  }

  const fresh = ids.filter((id) => !player.seen.includes(id)).reverse();
  if (fresh.length) await announceMatches(riot, cfg, player, fresh, send, getEntry);

  if (cfg.announceGameStart) await announceLiveGame(riot, player, send, getEntry);
}

/** How long to stop asking after the spectator endpoint refuses us. */
const SPECTATOR_RETRY_MS = 24 * 60 * 60 * 1000;

async function reportPlayerError(env: Env, state: TrackerState, riotId: string, err: unknown): Promise<void> {
  if (err instanceof RiotError && err.isRateLimited) {
    // Nothing to gain from sleeping inside a cron invocation — the next
    // tick is a minute away, which is longer than any Riot backoff.
    console.warn(`[rate] ${err.message}`);
    return;
  }

  if (err instanceof RiotError && err.isAuthFailure) {
    console.error(`[auth] ${err.message}`);
    if (state.keyAlerted) return;
    state.keyAlerted = true;
    await sender(env)(
      "🔑 Riot API key rejected — it has probably expired. Run <code>wrangler secret put RIOT_API_KEY</code> with a fresh one.",
    ).catch((e) => console.error(`[telegram] ${(e as Error).message}`));
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

  for (const riotId of cfg.players) {
    try {
      await checkPlayer(riot, env, cfg, state, riotId);
      state.keyAlerted = false;
    } catch (err) {
      await reportPlayerError(env, state, riotId, err);
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

  // Status page. Handy after deploying, and `wrangler dev` uses the separate
  // /__scheduled route to fire the cron handler on demand.
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
