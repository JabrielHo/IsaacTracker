export interface Env {
  // Secrets — set with `wrangler secret put`.
  RIOT_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;

  // Plain vars from wrangler.jsonc.
  RIOT_PLATFORM: string;
  PLAYERS: string;
  ANNOUNCE_GAME_START: string;
  /** "solo" or "double_up" — which ranked ladder to report LP from. */
  TRACK_QUEUE: string;

  TRACKER: KVNamespace;
}

export interface RiotAccount {
  puuid: string;
  gameName: string;
  tagLine: string;
}

// These describe only the parts of Riot's payloads this Worker actually reads,
// not the full schema -- so every field here is load-bearing.

export interface LeagueEntry {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
}

export interface Trait {
  name: string;
  num_units: number;
  style?: number;
  /** Number of breakpoints. Champion-unique traits have exactly 1. */
  tier_total?: number;
}

export interface Unit {
  character_id: string;
  tier: number;
  rarity: number;
  itemNames?: string[];
}

export interface Participant {
  puuid: string;
  placement: number;
  level: number;
  last_round: number;
  players_eliminated: number;
  time_eliminated?: number;
  gold_left?: number;
  total_damage_to_players?: number;
  /** Double Up only: teammates share this id. */
  partner_group_id?: number;
  riotIdGameName?: string;
  riotIdTagline?: string;
  traits: Trait[];
  units: Unit[];
}

export interface MatchInfo {
  game_length: number;
  /** Riot returns snake_case; some sets have also emitted camelCase. */
  queue_id?: number;
  queueId?: number;
  /** "GameComplete" for a finished game; anything else is a remake or abort. */
  endOfGameResult?: string;
  /** "standard" | "pairs" (Double Up) | "turbo". */
  tft_game_type?: string;
  participants: Participant[];
}

export interface Match {
  info: MatchInfo;
}

export interface PlayerState {
  puuid: string;
  displayName: string;
  /** Recently announced match ids, newest first. */
  seen: string[];
  /** Flattened tier+division+LP, for computing deltas across promotions. */
  ladder: number | null;
  inGame: boolean;
  bootstrapped: boolean;
}

export interface TrackerState {
  players: Record<string, PlayerState>;
  /** Set once we've warned the chat about a dead API key, so we only warn once. */
  keyAlerted?: boolean;
  /**
   * Epoch ms before which we skip the TFT spectator endpoint. Dev keys aren't
   * granted it (403), and retrying every minute costs a request and drowns out
   * real errors — but we do retry daily so upgrading the key self-heals.
   */
  spectatorRetryAt?: number;
}
