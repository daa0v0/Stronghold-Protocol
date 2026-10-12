// server/match/match/revive.js — Match methods a CODE MOD uses to bring a teammate back (docs/MODS.md).
//
// The shipped game has no revive. What stays HERE is the state change — the seat is out (`alive`, `eliminatedRound`, its LP),
// and the parts of the match that count alive players (the shared leader pool) have to agree — because a half-revived seat
// would leave the roster, the views and the invariant audit disagreeing. What belongs to the MOD is the RULE: who may be
// brought back, what it costs and how much health it returns (mods/revive-teammate).
//
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).
import { PHASE } from '../../../shared/constants.js';
import { bossPoolHp } from '../finalAssault.js';

export class MatchRevive {
  /**
   * The seats that are OUT and could come back, earliest eliminated first — never one that LEFT the match (a quit is not a
   * defeat, and the player is not there to be brought back).
   * @returns {{ playerId: string, name: string, seat: number, eliminatedRound: number|null }[]}
   */
  revivableTeammates() {
    return this.order
      .filter((ps) => ps && !ps.alive && !ps.left)
      .sort((a, b) => (a.eliminatedRound ?? Infinity) - (b.eliminatedRound ?? Infinity) || a.seat - b.seat)
      .map((ps) => ({ playerId: ps.playerId, name: ps.name, seat: ps.seat, eliminatedRound: ps.eliminatedRound ?? null }));
  }

  /**
   * Bring one teammate back with `lp` health (default: the health its band starts with, i.e. a full revive).
   * @param {string} playerId
   * @param {{ lp?: number }} [opts]
   * @returns {{ ok: true, playerId: string, lp: number } | { ok: false, error: string }}
   */
  revivePlayer(playerId, opts = {}) {
    const ps = this.players.get(playerId);
    if (!ps) return { ok: false, error: 'UNKNOWN_PLAYER' };
    if (ps.left) return { ok: false, error: 'LEFT' };
    if (ps.alive) return { ok: false, error: 'ALIVE' };
    const lp = Number.isFinite(opts.lp) ? opts.lp : this.gd.startLp(ps.bandId);
    if (this.sharedLp) {
      // One bar for the team: coming back does not change it, and an empty bar means nothing to come back to.
      const current = this.alivePlayers()[0]?.lp ?? 0;
      if (current <= 0) return { ok: false, error: 'TEAM_BAR_EMPTY' };
      ps.revive(current);
    } else ps.revive(lp);
    // A live leader pool is sized by the alive players (finalAssault.js bossPoolHp): a seat coming back grows it.
    if (this.bossPool && (this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE)) {
      const bossId = this.phase === PHASE.HIDDEN_CORE ? this.hiddenBossId : this.bossId;
      this.bossPool.rescale(bossPoolHp(this.gd, bossId, this.alivePlayers().length));
      this._broadcastPool?.(true);
    }
    this.markPrivate(ps);
    this.markPublic();
    return { ok: true, playerId: ps.playerId, lp: ps.lp };
  }
}
