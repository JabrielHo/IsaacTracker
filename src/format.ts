// Turns raw Riot payloads into the lines that land in the group chat.
import type { LeagueEntry, Match, MatchInfo, Participant, Trait, Unit } from "./types";

const TIERS = [
  "IRON",
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "EMERALD",
  "DIAMOND",
  "MASTER",
  "GRANDMASTER",
  "CHALLENGER",
] as const;
const MASTER_INDEX = TIERS.indexOf("MASTER");
const DIVISIONS: Record<string, number> = { IV: 0, III: 1, II: 2, I: 3 };

/**
 * Transcribed from DDragon's per-patch queue table, which is what the game
 * client itself renders -- NOT from the developer-site queues.json, which lists
 * four TFT queues and gets the rest wrong.
 *
 *   https://ddragon.leagueoflegends.com/cdn/16.15.1/data/en_US/tft-queues.json
 *
 * Mirrors that patch exactly: retired modes are dropped as Riot drops them, and
 * a returning mode comes back under a NEW id anyway (Choncc's Treasure ran as
 * 1190, then returned as 1210), so an old id is dead weight rather than a
 * fallback. Anything missing renders as "Queue <id>" -- re-check this list
 * against a current DDragon patch whenever one of those shows up.
 */
const QUEUES: Record<number, string> = {
  1090: "Normal",
  1100: "Ranked",
  1110: "Tutorial",
  1130: "Hyper Roll",
  1160: "Double Up",
  1170: "Fortune's Favor",
  1210: "Choncc's Classic Treasure",
  1220: "Tocker's Trials",
  6000: "Revival: Festival of Beasts",
  6100: "Choncc's K.O. Coliseum",
  6120: "Pengu's Party",
  6130: "Ao Shin's Ascent",
};

const PLACEMENT_LABEL = ["🥇 1st", "🥈 2nd", "🥉 3rd", "4th", "5th", "6th", "7th", "8th"];

/** Medal for the podium, plain ordinal past it. `n` is 1-based. */
function placementLabel(n: number): string {
  return PLACEMENT_LABEL[n - 1] ?? `${n}th`;
}

/** "DarkStar" -> "Dark Star". Leaves acronyms like "DRX" and "ADMIN" alone. */
const splitCamel = (s: string): string => s.replace(/([a-z])([A-Z])/g, "$1 $2");

/** Strips the set prefix Riot puts on every asset id: "TFT17_Aatrox" -> "Aatrox". */
const stripSet = (id = ""): string => splitCamel(id.replace(/^TFT\d*[a-z]*_/i, "").replaceAll("_", " "));

/**
 * Item ids carry their own prefixes and, for artifact/emblem variants, extra
 * qualifiers: "TFT9_Item_OrnnHorizonFocus" -> "Ornn Horizon Focus",
 * "TFT17_Item_DarkStarEmblemItem" -> "Dark Star Emblem".
 */
const stripItem = (id = ""): string =>
  splitCamel(
    id
      .replace(/^TFT\d*_?Item_/i, "")
      .replace(/^Artifact_/i, "")
      .replace(/Item$/, ""),
  );

/** Thief's Gloves fills its unused slots with this placeholder. */
const isRealItem = (id: string): boolean => !/EmptyBag$/i.test(id);

/**
 * Riot exposes internal traits alongside real ones -- stat buckets whose names
 * end in "Trait"/"Tank" (ASTrait, HPTank, ManaTrait) and per-champion
 * "…UniqueTrait" entries. They carry real style values, so without this filter
 * they outrank the traits a player would actually name.
 */
function isDisplayTrait(t: Trait): boolean {
  const short = t.name.replace(/^TFT\d*[a-z]*_/i, "");
  if (/(Trait|Tank)$/.test(short)) return false;
  // A champion-unique trait has a single breakpoint; real traits have 2+.
  return (t.tier_total ?? 2) > 1;
}

const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function queueId(info: MatchInfo): number | undefined {
  return info.queue_id ?? info.queueId;
}

export function queueName(info: MatchInfo): string {
  const id = queueId(info);
  return (id !== undefined ? QUEUES[id] : undefined) ?? `Queue ${id}`;
}

/**
 * Which ladder to report. Solo and Double Up are separate ranks on separate
 * queues, so the league entry and the match ids have to be chosen together --
 * reading solo LP off a Double Up game would produce nonsense deltas.
 */
export interface QueueProfile {
  leagueQueueType: string;
  matchQueueIds: number[];
  label: string;
}

const PROFILES = {
  solo: {
    leagueQueueType: "RANKED_TFT",
    matchQueueIds: [1100],
    label: "Ranked",
  },
  double_up: {
    leagueQueueType: "RANKED_TFT_DOUBLE_UP",
    matchQueueIds: [1160],
    label: "Double Up",
  },
} as const satisfies Record<string, QueueProfile>;

export const QUEUE_NAMES = Object.keys(PROFILES);

/**
 * Returns undefined for anything unrecognised so the caller can reject it.
 * Silently falling back to solo would track the wrong ladder forever on a typo.
 */
export function resolveQueueProfile(name?: string): QueueProfile | undefined {
  const key = (name ?? "solo").toLowerCase().replace(/[\s-]/g, "_");
  return key in PROFILES ? PROFILES[key as keyof typeof PROFILES] : undefined;
}

/** True when this match belongs to the ladder we're tracking. */
export function isTrackedQueue(info: MatchInfo, profile: QueueProfile): boolean {
  const id = queueId(info);
  return id !== undefined && profile.matchQueueIds.includes(id);
}

/**
 * Tier index, plus whether it sits in the flat LP pool above the division
 * system. Both callers below need the same two facts, and the Master cutoff
 * should only be spelled out once.
 */
function tierInfo(tier: string): { index: number; isApex: boolean } {
  const index = TIERS.indexOf(tier as (typeof TIERS)[number]);
  return { index, isApex: index >= MASTER_INDEX };
}

/** Flattens tier/division/LP into one number so promotions don't break the delta. */
export function ladderPoints(entry: LeagueEntry | null): number | null {
  if (!entry) return null;
  const { index, isApex } = tierInfo(entry.tier);
  if (index < 0) return null;
  if (isApex) return MASTER_INDEX * 400 + entry.leaguePoints;
  return index * 400 + (DIVISIONS[entry.rank] ?? 0) * 100 + entry.leaguePoints;
}

export function rankLabel(entry: LeagueEntry | null): string {
  if (!entry) return "Unranked";
  const tier = entry.tier.charAt(0) + entry.tier.slice(1).toLowerCase();
  if (tierInfo(entry.tier).isApex) return `${tier} ${entry.leaguePoints} LP`;
  return `${tier} ${entry.rank} ${entry.leaguePoints} LP`;
}

function duration(seconds: number | undefined): string {
  const total = Math.round(seconds ?? 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The 2-3 traits that actually define the board, strongest tier first. */
function topTraits(traits: Trait[] = []): string[] {
  return traits
    .filter((t) => (t.style ?? 0) > 0 && isDisplayTrait(t))
    .sort((a, b) => (b.style ?? 0) - (a.style ?? 0) || b.num_units - a.num_units)
    .slice(0, 3)
    .map((t) => `${t.num_units} ${stripSet(t.name)}`);
}

/** 3-stars first (they're the story), then the highest-cost units, with items. */
function keyUnits(units: Unit[] = []): string[] {
  return [...units]
    .sort((a, b) => b.tier - a.tier || b.rarity - a.rarity)
    .slice(0, 3)
    .map((u) => {
      const name = u.tier >= 3 ? `⭐${stripSet(u.character_id)}` : stripSet(u.character_id);
      const items = (u.itemNames ?? []).filter(isRealItem).map(stripItem);
      return items.length ? `${name} — ${items.join(", ")}` : name;
    });
}

/** Double Up runs four teams of two, so a raw 1-8 placement reads wrong. */
export function isPairs(info: MatchInfo): boolean {
  return info.tft_game_type === "pairs";
}

/**
 * Team standing in a Double Up lobby. Derived by ranking the partner groups on
 * their best placement rather than halving the raw placement -- teammates
 * happen to get adjacent numbers, but nothing documents that as guaranteed.
 */
function teamStanding(info: MatchInfo, me: Participant): { rank: number; teams: number } | null {
  if (!isPairs(info) || me.partner_group_id === undefined) return null;

  const bestByGroup = new Map<number, number>();
  for (const p of info.participants) {
    if (p.partner_group_id === undefined) continue;
    const best = bestByGroup.get(p.partner_group_id);
    if (best === undefined || p.placement < best) bestByGroup.set(p.partner_group_id, p.placement);
  }

  const mine = bestByGroup.get(me.partner_group_id);
  if (mine === undefined) return null;

  let ahead = 0;
  for (const [group, best] of bestByGroup) {
    if (group !== me.partner_group_id && best < mine) ahead++;
  }
  return { rank: ahead + 1, teams: bestByGroup.size };
}

/** The teammate's display name in a Double Up lobby, if it can be identified. */
function partnerName(info: MatchInfo, me: Participant): string | null {
  if (!isPairs(info) || me.partner_group_id === undefined) return null;
  const mate = info.participants.find((p) => p.partner_group_id === me.partner_group_id && p.puuid !== me.puuid);
  return mate?.riotIdGameName ?? null;
}

export function formatResult(args: {
  displayName: string;
  match: Match;
  me: Participant;
  rankEntry: LeagueEntry | null;
  lpDelta: number | null;
}): string {
  const { displayName, match, me, rankEntry, lpDelta } = args;
  const info = match.info;

  // In Double Up the pair's standing is the result; the raw 1-8 placement makes
  // the winner's partner look like they came 2nd.
  const team = teamStanding(info, me);
  const placement = team ? `${placementLabel(team.rank)} of ${team.teams} teams` : placementLabel(me.placement);

  const lines: string[] = [];

  const mate = partnerName(info, me);
  const withMate = mate ? ` + ${esc(mate)}` : "";
  let header = `${placement} — <b>${esc(displayName)}</b>${withMate}`;
  if (rankEntry) {
    let delta = "";
    if (lpDelta !== null) {
      const sign = lpDelta >= 0 ? "+" : "";
      delta = ` (${sign}${lpDelta} LP)`;
    }
    header += `\n${esc(rankLabel(rankEntry))}${delta}`;
  } else {
    header += `\n${esc(queueName(info))}`;
  }
  lines.push(header);

  const traits = topTraits(me.traits);
  if (traits.length) lines.push(`🧩 ${esc(traits.join(" · "))}`);

  // One carry per line: with items attached, a single joined line runs well past
  // 150 characters and wraps badly on a phone.
  const units = keyUnits(me.units);
  if (units.length) {
    lines.push(units.map((u, i) => `${i === 0 ? "🎯" : "   "} ${esc(u)}`).join("\n"));
  }

  const stats = [`Lv ${me.level}`, `round ${me.last_round}`];
  if (me.total_damage_to_players !== undefined) stats.push(`${me.total_damage_to_players} dmg`);
  if (me.players_eliminated > 0) stats.push(`${me.players_eliminated} elims`);
  if (me.gold_left !== undefined) stats.push(`${me.gold_left}g left`);
  stats.push(duration(me.time_eliminated ?? info.game_length));
  lines.push(`📊 ${esc(stats.join(" · "))}`);

  return lines.join("\n");
}

export function formatGameStart(displayName: string, rankEntry: LeagueEntry | null): string {
  const rank = rankEntry ? ` · ${rankLabel(rankEntry)}` : "";
  return `🎮 <b>${esc(displayName)}</b> just queued into a game${esc(rank)}`;
}
