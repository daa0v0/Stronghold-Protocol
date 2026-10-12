// server/match/match/lp.js — the one place a player's health changes, so a CODE MOD can make the team share it
// (docs/MODS.md, mods/shared-health-bar).
//
// The shipped game gives every seat its own LP (`ps.lp`, set from the band's `totalHp` and spent by battle damage, the
// hidden core's redistribution and elimination). A shared bar is a rule about that value — all alive teammates always hold
// the same one, and its size comes from the rule `sharedLp` (shared/matchRules.js) — and a rule applied at four different
// assignment sites would drift. So every write goes through `applyLp` here: with no rule in force it writes that one player
// exactly as before, with a rule in force it writes the whole alive team.
//
// NOT to be confused with `Match.teamLp`, the shipped merged pool of the Final Assault / Hidden Core (the SUM of the alive
// seats' LP, alive only in the boss phases). This module is about the per-seat LP the whole match uses.
//
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).
import { sharedLpRule } from '../../../shared/matchRules.js';

export class MatchLp {
  /** The shared-health-bar rule in force, or null. */
  get sharedLp() { return sharedLpRule(); }

  /**
   * The size the team's one bar starts at, from the rule: the SUM or the MAX of the teammates' chosen bands' `totalHp`
   * (`source: 'band'`) or of the health they hold right now (`source: 'lp'`). `null` when no rule is in force.
   * @param {import('../PlayerState.js').PlayerState[]} [members]
   * @returns {number|null}
   */
  sharedLpSize(members = this.alivePlayers()) {
    const rule = this.sharedLp;
    if (!rule || !members.length) return null;
    const values = members.map((ps) => (rule.source === 'lp' ? ps.lp : this.gd.startLp(ps.bandId)))
      .filter((v) => Number.isFinite(v));
    if (!values.length) return null;
    return rule.mode === 'max' ? Math.max(...values) : values.reduce((s, v) => s + v, 0);
  }

  /**
   * Set one player's health — and, under the shared rule, the whole alive team's, which is what makes it one bar.
   * @param {import('../PlayerState.js').PlayerState} ps
   * @param {number} value
   * @returns {number} the value actually stored
   */
  applyLp(ps, value) {
    const lp = Math.max(0, Math.round(Number(value) || 0));
    if (ps.lp !== lp) { ps.lp = lp; ps.dirty(); }
    const rule = this.sharedLp;
    if (!rule) return lp;
    for (const other of this.alivePlayers()) {
      if (other === ps || other.lp === lp) continue;
      other.lp = lp;
      other.dirty();
    }
    this.markPublic();
    return lp;
  }

  /** Spend `loss` health from a player (the shared bar, when the rule is on) — the battle-damage path. */
  loseLp(ps, loss) {
    return this.applyLp(ps, ps.lp - (Number(loss) || 0));
  }

  /**
   * Build the team's one bar. Called once every band is known (the end of the band draft), because the size depends on the
   * bands the whole team picked. No-op without the rule.
   * @param {import('../PlayerState.js').PlayerState[]} [members]
   * @returns {number|null}
   */
  initSharedLp(members = this.alivePlayers()) {
    const size = this.sharedLpSize(members);
    if (size == null) return null;
    for (const ps of members) this.applyLp(ps, size);
    return size;
  }
}
