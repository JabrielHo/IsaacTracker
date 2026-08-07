import type { LeagueEntry, Match, RiotAccount } from "./types";

const PLATFORM_TO_MATCH_CLUSTER: Record<string, string> = {
  na1: "americas",
  br1: "americas",
  la1: "americas",
  la2: "americas",
  euw1: "europe",
  eun1: "europe",
  tr1: "europe",
  ru: "europe",
  me1: "europe",
  kr: "asia",
  jp1: "asia",
  oc1: "sea",
  ph2: "sea",
  sg2: "sea",
  th2: "sea",
  tw2: "sea",
  vn2: "sea",
};

// account-v1 only lives on these three clusters, and the mapping for SEA/OCE has
// moved around historically -- so we probe rather than hardcode.
const ACCOUNT_CLUSTERS = ["asia", "americas", "europe"] as const;

export class RiotError extends Error {
  private static describe(status: number, url: string, body: string): string {
    const detail = body ? ` :: ${body.slice(0, 200)}` : "";
    return `Riot API ${status} for ${url}${detail}`;
  }

  constructor(
    readonly status: number,
    readonly url: string,
    body = "",
  ) {
    super(RiotError.describe(status, url, body));
    this.name = "RiotError";
  }

  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

export interface RiotClientOptions {
  /** Epoch ms before which the spectator endpoint should not be attempted. */
  spectatorRetryAt?: number;
  /** Current time, for comparing against spectatorRetryAt. */
  now?: number;
}

export class RiotClient {
  private readonly platform: string;
  private matchCluster: string;
  private accountCluster: string | null = null;

  /**
   * Flipped off if Riot's TFT spectator route answers with anything unexpected.
   * A fresh client is built every invocation, so the caller seeds this from a
   * persisted deadline rather than letting each tick rediscover the failure.
   */
  private spectatorOff: boolean;

  constructor(
    private readonly apiKey: string,
    platform: string,
    opts: RiotClientOptions = {},
  ) {
    this.platform = platform.toLowerCase();
    this.matchCluster = PLATFORM_TO_MATCH_CLUSTER[this.platform] ?? "americas";
    this.spectatorOff = opts.spectatorRetryAt !== undefined && (opts.now ?? 0) < opts.spectatorRetryAt;
  }

  get spectatorSupported(): boolean {
    return !this.spectatorOff;
  }

  private async get<T>(host: string, path: string, allow404 = false): Promise<T | null> {
    const url = `https://${host}.api.riotgames.com${path}`;
    const res = await fetch(url, { headers: { "X-Riot-Token": this.apiKey } });

    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new RiotError(res.status, url, body);
    }
    return res.json<T>();
  }

  async resolveAccount(gameName: string, tagLine: string): Promise<RiotAccount> {
    const path = `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    const clusters = this.accountCluster ? [this.accountCluster] : ACCOUNT_CLUSTERS;

    let lastErr: unknown = null;
    for (const cluster of clusters) {
      try {
        const account = await this.get<RiotAccount>(cluster, path, true);
        if (account) {
          this.accountCluster = cluster;
          return account;
        }
      } catch (err) {
        // A rejected key won't start working on a different cluster.
        if (err instanceof RiotError && err.isAuthFailure) throw err;
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    throw new Error(`Riot ID "${gameName}#${tagLine}" not found on any account cluster`);
  }

  async recentMatchIds(puuid: string, count = 5): Promise<string[]> {
    const path = `/tft/match/v1/matches/by-puuid/${puuid}/ids?start=0&count=${count}`;
    const ids = await this.get<string[]>(this.matchCluster, path, true);
    if (ids) return ids;

    // SEA accounts sometimes answer on the asia cluster instead. Latch onto
    // whichever one works so we only pay for this probe once.
    if (this.matchCluster === "sea") {
      const fallback = await this.get<string[]>("asia", path, true);
      if (fallback) {
        this.matchCluster = "asia";
        return fallback;
      }
    }
    return [];
  }

  async match(matchId: string): Promise<Match> {
    const match = await this.get<Match>(this.matchCluster, `/tft/match/v1/matches/${matchId}`);
    if (!match) throw new Error(`Match ${matchId} not found`);
    return match;
  }

  /** @param queueType e.g. RANKED_TFT or RANKED_TFT_DOUBLE_UP -- separate ladders. */
  async rankedEntry(puuid: string, queueType: string): Promise<LeagueEntry | null> {
    const entries = await this.get<LeagueEntry[]>(this.platform, `/tft/league/v1/by-puuid/${puuid}`, true);
    if (!Array.isArray(entries)) return null;
    return entries.find((e) => e.queueType === queueType) ?? null;
  }

  /**
   * True if a game is live, null if the endpoint isn't usable. Riot has shipped
   * and reshuffled the TFT spectator route more than once, so anything other
   * than a clean 404 disables the feature instead of failing the whole run.
   */
  async isInGame(puuid: string): Promise<boolean | null> {
    if (this.spectatorOff) return null;
    try {
      const game = await this.get<unknown>(this.platform, `/lol/spectator/tft/v5/active-games/by-puuid/${puuid}`, true);
      return game !== null;
    } catch (err) {
      if (err instanceof RiotError && err.isRateLimited) throw err;
      this.spectatorOff = true;
      console.warn(`[spectator] disabled: ${(err as Error).message}`);
      return null;
    }
  }
}
