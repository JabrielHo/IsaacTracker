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

const QUEUES: Record<number, string> = {
  1090: "Normal",
  1100: "Ranked",
  1110: "Tutorial",
  1130: "Hyper Roll",
  1150: "Double Up",
  1160: "Double Up",
  1170: "Fortune's Favor",
  1180: "Soul Brawl",
  1190: "Choncc's Treasure",
  1210: "Tocker's Trials",
};

const PLACEMENT_LABEL = ["🥇 1st", "🥈 2nd", "🥉 3rd", "4th", "5th", "6th", "7th", "8th"];

/** Strips the set prefix Riot puts on every asset id: "TFT14_Aphelios" -> "Aphelios". */
const stripSet = (id = ""): string => id.replace(/^TFT\d*[a-z]*_/i, "").replaceAll("_", " ");

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
    // Riot has used both ids for ranked Double Up across sets.
    matchQueueIds: [1150, 1160],
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
    .filter((t) => (t.style ?? 0) > 0)
    .sort((a, b) => (b.style ?? 0) - (a.style ?? 0) || b.num_units - a.num_units)
    .slice(0, 3)
    .map((t) => `${t.num_units} ${stripSet(t.name)}`);
}

/** 3-stars first (they're the story), then the highest-cost units. */
function keyUnits(units: Unit[] = []): string[] {
  return [...units]
    .sort((a, b) => b.tier - a.tier || b.rarity - a.rarity)
    .slice(0, 3)
    .map((u) => {
      const name = stripSet(u.character_id);
      return u.tier >= 3 ? `⭐${name}` : name;
    });
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
  const placement = PLACEMENT_LABEL[me.placement - 1] ?? `${me.placement}th`;

  const lines: string[] = [];

  let header = `${placement} — <b>${esc(displayName)}</b>`;
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

  const units = keyUnits(me.units);
  if (units.length) lines.push(`🎯 ${esc(units.join(", "))}`);

  lines.push(
    `📊 ${esc(
      [
        `Lv ${me.level}`,
        `round ${me.last_round}`,
        `${me.players_eliminated} elims`,
        duration(me.time_eliminated ?? info.game_length),
      ].join(" · "),
    )}`,
  );

  return lines.join("\n");
}

export function formatGameStart(displayName: string, rankEntry: LeagueEntry | null): string {
  const rank = rankEntry ? ` · ${rankLabel(rankEntry)}` : "";
  return `🎮 <b>${esc(displayName)}</b> just queued into a game${esc(rank)}`;
}
