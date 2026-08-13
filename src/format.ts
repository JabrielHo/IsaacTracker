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

/**
 * Trait API name -> in-game display name, transcribed from the same DDragon
 * patch as QUEUES above:
 *
 *   https://ddragon.leagueoflegends.com/cdn/16.15.1/data/en_US/tft-trait.json
 *
 * Riot's API names are internal dev labels ("TFT17_HPTank" is Brawler,
 * "TFT17_DRX" is N.O.V.A.), so nothing renderable can be derived from the id
 * itself. Anything missing falls back to the de-prefixed id, which is at least
 * legible -- re-transcribe this table when a new set ships.
 */
const TRAIT_NAMES: Record<string, string> = {
  TFT17_ADMIN: "Arbiter",
  TFT17_AnimaSquad: "Anima",
  TFT17_APTrait: "Replicator",
  TFT17_ASTrait: "Challenger",
  TFT17_AssassinTrait: "Rogue",
  TFT17_Astronaut: "Meeple",
  TFT17_BlitzcrankUniqueTrait: "Party Animal",
  TFT17_DarkStar: "Dark Star",
  TFT17_DRX: "N.O.V.A.",
  TFT17_Fateweaver: "Fateweaver",
  TFT17_FioraUniqueTrait: "Divine Duelist",
  TFT17_FlexTrait: "Voyager",
  TFT17_GravesTrait: "Factory New",
  TFT17_HPTank: "Brawler",
  TFT17_JhinUniqueTrait: "Eradicator",
  TFT17_ManaTrait: "Conduit",
  TFT17_Mecha: "Mecha",
  TFT17_MeleeTrait: "Marauder",
  TFT17_MissFortuneUniqueTrait: "Gun Goddess",
  TFT17_MorganaUniqueTrait: "Dark Lady",
  TFT17_Primordian: "Primordian",
  TFT17_PsyOps: "Psionic",
  TFT17_RangedTrait: "Sniper",
  TFT17_ResistTank: "Bastion",
  TFT17_RhaastUniqueTrait: "Redeemer",
  TFT17_ShenUniqueTrait: "Bulwark",
  TFT17_ShieldTank: "Vanguard",
  TFT17_SonaUniqueTrait: "Commander",
  TFT17_SpaceGroove: "Space Groove",
  TFT17_Stargazer: "Stargazer",
  TFT17_Stargazer_Fountain: "Stargazer",
  TFT17_Stargazer_Huntress: "Stargazer",
  TFT17_Stargazer_Medallion: "Stargazer",
  TFT17_Stargazer_Mountain: "Stargazer",
  TFT17_Stargazer_Serpent: "Stargazer",
  TFT17_Stargazer_Shield: "Stargazer",
  TFT17_Stargazer_Wolf: "Stargazer",
  TFT17_SummonTrait: "Shepherd",
  TFT17_TahmKenchUniqueTrait: "Oracle",
  TFT17_Timebreaker: "Timebreaker",
  TFT17_VexUniqueTrait: "Doomer",
  TFT17_ZedUniqueTrait: "Galaxy Hunter",
};

const traitName = (id: string): string => TRAIT_NAMES[id] ?? stripSet(id);

const PLACEMENT_LABEL = ["🥇 1st", "🥈 2nd", "🥉 3rd", "4th", "5th", "6th", "7th", "8th"];

/**
 * Only the top two teams gain LP in Double Up, so a 🥉 on "3rd of 4" would sit
 * next to a negative LP delta and read as a win.
 */
const TEAM_LABEL = ["🥇 1st", "🥈 2nd", "3rd", "4th"];

/** Label from the table, plain ordinal past its end. `n` is 1-based. */
function ordinal(table: readonly string[], n: number): string {
  return table[n - 1] ?? `${n}th`;
}

/** "DarkStar" -> "Dark Star". Leaves acronyms like "DRX" and "ADMIN" alone. */
const splitCamel = (s: string): string => s.replace(/([a-z])([A-Z])/g, "$1 $2");

/** Strips the set prefix Riot puts on every asset id: "TFT17_Aatrox" -> "Aatrox". */
const stripSet = (id = ""): string => splitCamel(id.replace(/^TFT\d*[a-z]*_/i, "").replaceAll("_", " "));

/**
 * Item ids are underscore-joined segments around an "Item" marker, decorated
 * with optional qualifiers. One tokenizing pass handles every shape, so each
 * rule is stated exactly once instead of once per id variant:
 *
 *   TFT_Item_InfinityEdge                    -> "Infinity Edge"
 *   TFT9_Item_OrnnHorizonFocus               -> "Ornn Horizon Focus"
 *   TFT17_Item_RangedTraitEmblemItem         -> "Sniper Emblem"
 *   TFT17_AnimaSquadItem_Tier2_LionessLament -> "Lioness Lament (T2)"
 *
 * Emblems embed the trait's dev name, which only the trait table can translate
 * ("Sniper Emblem", not "Ranged Trait Emblem"). The set-mechanic segment is
 * dropped — the unit holding the item already implies it — while the upgrade
 * tier is real information and kept, compressed.
 */
function itemName(id: string): string {
  const tokens = id.split("_");

  let set = "";
  if (/^TFT\d*[a-z]*$/i.test(tokens[0] ?? "")) set = tokens.shift() ?? "";

  // The marker segment ends in "Item": usually it is exactly that, but a set
  // mechanic gets glued onto it ("AnimaSquadItem"), which is why matching the
  // bare token isn't enough. Everything up to and including the marker is
  // provenance rather than name. The final segment is never the marker -- it is
  // the name, and emblems legitimately end in "EmblemItem".
  const marker = tokens.findIndex((t, i) => i < tokens.length - 1 && /Item$/i.test(t));
  if (marker >= 0) tokens.splice(0, marker + 1);

  let tier = "";
  const rest = tokens.filter((t) => {
    const m = /^Tier(\d+)$/.exec(t);
    if (m) tier = ` (T${m[1]})`;
    return !m && t !== "Artifact";
  });

  const joined = rest.join(" ");
  const emblem = /^(\w+?)EmblemItem$/.exec(joined);
  if (emblem && set) return `${traitName(set + "_" + emblem[1])} Emblem${tier}`;

  return splitCamel(joined.replace(/Item$/, "")) + tier;
}

/** Thief's Gloves fills its unused slots with this placeholder. */
const isRealItem = (id: string): boolean => !/EmptyBag$/i.test(id);

const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function queueId(info: MatchInfo): number | undefined {
  return info.queue_id ?? info.queueId;
}

export function queueName(info: MatchInfo): string {
  const id = queueId(info);
  return QUEUES[id ?? -1] ?? `Queue ${id}`;
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
 * Defaulting an unset value is the caller's decision — all config policy lives
 * in readConfig, not here.
 */
export function resolveQueueProfile(name: string): QueueProfile | undefined {
  const key = name.toLowerCase().replace(/[\s-]/g, "_");
  return key in PROFILES ? PROFILES[key as keyof typeof PROFILES] : undefined;
}

/** True when this match belongs to the ladder we're tracking. */
function isTrackedQueue(info: MatchInfo, profile: QueueProfile): boolean {
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

/**
 * Riot only exposes a flat round counter, but everyone reads stages: op.gg and
 * the in-game UI both say "5-6", never "round 31". Stage 1 is four PvE rounds,
 * every stage after that is seven.
 */
function stageLabel(round: number): string {
  if (round <= 4) return `1-${round}`;
  return `${2 + Math.floor((round - 5) / 7)}-${((round - 5) % 7) + 1}`;
}

/**
 * Every active trait, strongest style first -- the same set and order as the
 * trait chips on an op.gg match card. style 0 means the trait never hit its
 * first breakpoint, which is the only kind worth dropping: what look like
 * internal stat buckets (ASTrait, HPTank) are real traits under dev names,
 * and TRAIT_NAMES carries their display names.
 */
function activeTraits(traits: Trait[] = []): string[] {
  return traits
    .filter((t) => (t.style ?? 0) > 0)
    .sort((a, b) => (b.style ?? 0) - (a.style ?? 0) || b.num_units - a.num_units)
    .map((t) => `${t.num_units} ${traitName(t.name)}`);
}

/**
 * `rarity` is not the shop cost: it runs on a doubled scale (0/1/2/4/6). Mapped
 * to the cost colours op.gg paints on unit borders. Values outside the table
 * (future 6-costs, set-mechanic specials) get no dot rather than a wrong colour.
 */
const COST_DOT: Record<number, string> = { 0: "⚪", 1: "🟢", 2: "🔵", 4: "🟣", 6: "🟡" };

/**
 * The whole final board, highest cost first, star level breaking ties -- so the
 * cost dots read as ordered bands. Itemized units get a line each; a *run* of
 * consecutive itemless ones folds into one line, which keeps a 9-unit board off
 * 9 rows on a phone without letting the fold reorder anything. Folding every
 * itemless unit into one trailing line instead would drop a bare 5-cost below
 * an itemized 4-cost, and then the dots no longer descend.
 */
function boardLines(units: Unit[] = []): string[] {
  const named = [...units]
    .sort((a, b) => b.rarity - a.rarity || b.tier - a.tier)
    .map((u) => ({
      // Star level on every unit, like op.gg -- text stars, not the ⭐ emoji,
      // which at three-per-unit would swallow the names around it.
      name: `${COST_DOT[u.rarity] ?? ""}${"★".repeat(u.tier)}${stripSet(u.character_id)}`,
      items: (u.itemNames ?? []).filter(isRealItem).map(itemName),
    }));

  const lines: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length) lines.push(run.join(" · "));
    run = [];
  };

  for (const u of named) {
    if (!u.items.length) {
      run.push(u.name);
      continue;
    }
    flush();
    lines.push(`${u.name} — ${u.items.join(", ")}`);
  }
  flush();

  return lines;
}

/** Double Up runs four teams of two, so a raw 1-8 placement reads wrong. */
function isPairs(info: MatchInfo): boolean {
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
  entry: LeagueEntry | null;
  queue: QueueProfile;
  lpDelta: number | null;
}): string {
  const { displayName, match, me, entry, queue, lpDelta } = args;
  const info = match.info;

  // Rank and LP only make sense on the tracked ladder; anything else gets the
  // queue name as its second line instead.
  const rankEntry = isTrackedQueue(info, queue) ? entry : null;

  // In Double Up the pair's standing is the result; the raw 1-8 placement makes
  // the winner's partner look like they came 2nd.
  const team = teamStanding(info, me);
  const placement = team
    ? `${ordinal(TEAM_LABEL, team.rank)} of ${team.teams} teams`
    : ordinal(PLACEMENT_LABEL, me.placement);

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

  const traits = activeTraits(me.traits);
  if (traits.length) lines.push(`🧩 ${esc(traits.join(" · "))}`);

  // One itemized unit per line: with items attached, a single joined line runs
  // well past 150 characters and wraps badly on a phone.
  const units = boardLines(me.units);
  if (units.length) {
    lines.push(units.map((u, i) => `${i === 0 ? "🎯" : "   "} ${esc(u)}`).join("\n"));
  }

  const stats = [`Lv ${me.level}`, `stage ${stageLabel(me.last_round)}`];
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

export function formatTracking(displayName: string, entry: LeagueEntry | null, queueLabel: string): string {
  return `👀 Now tracking <b>${esc(displayName)}</b> — ${esc(rankLabel(entry))} (${esc(queueLabel)})`;
}
