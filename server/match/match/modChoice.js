// server/match/match/modChoice.js — Match methods: offering, answering and expiring a CODE MOD's player choice, plus the
// settle moment a mod hooks into (docs/MODS.md §4.6, shared/modChoices.js).
//
// The plumbing is deliberately thin: a mod choice lives in `ps.personalChoice` — the field the 教鞭 Art already uses — so the
// existing `m.private` payload, the `g.choice` message and the client's ChoiceView carry it without a single new wire type.
// The differences from the Art's choice are the ones the mod needs: it is answered in the window between the settle that
// eliminated someone and the next prep (not only inside PREP), and its pick runs the mod's handler instead of becoming a
// bounty.
//
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).
import { ERR, PHASE } from '../../../shared/constants.js';
import { modChoice, modSettleHooks } from '../../../shared/modChoices.js';
import { OK, fail } from './common.js';

/** The phases a mod choice may be answered in: the settle that eliminated someone, up to the next prep. */
export const MOD_CHOICE_WINDOW = Object.freeze([
  PHASE.SETTLE, PHASE.ROUND_START, PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.BATTLE_CHECK, PHASE.PREP,
]);

export class MatchModChoice {
  /**
   * Whether one code mod is on for THIS match (docs/MODS.md §4.6). A room that did not narrow the code mods (`roomMods` is
   * null) runs every mod the server enabled; a room that did runs only the ones it picked. A mod asks this from its own
   * hooks — it is loaded once, server-wide, so it has no per-match setup of its own.
   * @param {string} id
   */
  modEnabled(id) {
    return this.roomMods == null ? true : this.roomMods.includes(id);
  }

  /**
   * Ask one player a mod's question. An AI seat (or a human under AI 托管) is never asked — it would have to answer itself —
   * and a seat that already has a choice open stays busy, so one prompt at a time.
   * @param {import('../PlayerState.js').PlayerState} ps
   * @param {string} choiceId a registered `registerModChoice` id
   * @param {{ title?: string, desc?: string, cards?: any[], data?: any }} [payload]
   * @returns {{ ok: true, id: string } | { ok: false, error: string }}
   */
  offerModChoice(ps, choiceId, { title = '', desc = '', cards = [], data = null } = {}) {
    const def = modChoice(choiceId);
    if (!def) return { ok: false, error: 'UNKNOWN_CHOICE' };
    if (!ps || !ps.alive || ps.left) return { ok: false, error: 'NOT_ELIGIBLE' };
    if (ps.botControlled) return { ok: false, error: 'BOT' };
    if (ps.personalChoice) return { ok: false, error: 'BUSY' };
    if (!Array.isArray(cards) || !cards.length) return { ok: false, error: 'NO_CARDS' };
    ps.personalChoice = {
      id: `${this.battlePrefix}.mod.${this.nextUid()}`, round: this.round, modId: choiceId,
      title, desc, cards: cards.map((c) => ({ ...c })), data,
    };
    ps.dirty();
    this.markPrivate(ps);
    return { ok: true, id: ps.personalChoice.id };
  }

  /** g.choice while a mod choice is open: run the mod's handler and close it. */
  pickModChoice(ps, idx, choiceId) {
    const pending = ps && ps.personalChoice;
    if (!pending || !pending.modId) return fail(ERR.BAD_TARGET);
    if (choiceId !== undefined && pending.id !== choiceId) return fail(ERR.BAD_TARGET);
    if (!MOD_CHOICE_WINDOW.includes(this.phase)) return fail(ERR.WRONG_PHASE);
    if (!Number.isInteger(idx) || idx < 0 || idx >= pending.cards.length) return fail(ERR.BAD_TARGET);
    const def = modChoice(pending.modId);
    const picked = { card: pending.cards[idx], idx, data: pending.data };
    ps.personalChoice = null;
    ps.dirty();
    try { def?.onPick?.(this, ps, picked); } catch (e) { this.reportError(`mod choice ${pending.modId}`, e); }
    this.markPrivate(ps);
    this.markPublic();
    return OK;
  }

  /**
   * A mod choice nobody answered — the window closed (the next prep is starting) or the seat is finishing its turn. Runs the
   * mod's decline path so the rule ("no answer = no revive") lives with the mod, not here.
   */
  autoModChoice(ps) {
    const pending = ps && ps.personalChoice;
    if (!pending || !pending.modId) return undefined;
    const def = modChoice(pending.modId);
    ps.personalChoice = null;
    ps.dirty();
    try { def?.onDecline?.(this, ps, { data: pending.data }); } catch (e) { this.reportError(`mod choice decline ${pending.modId}`, e); }
    return { declined: pending.modId };
  }

  /** Every open mod choice expires now (a phase the window does not cover, a shutdown, tests). */
  expireModChoices() {
    for (const ps of this.order) this.autoModChoice(ps);
  }

  /**
   * The settle moment (docs/MODS.md §4.6): run every registered hook once per settle in which at least one seat went out.
   * @param {import('../PlayerState.js').PlayerState[]} justOut the seats this settle eliminated
   */
  runModSettleHooks(justOut) {
    const hooks = modSettleHooks();
    if (!hooks.length || !justOut.length) return;
    const eliminated = justOut.map((ps) => ({
      playerId: ps.playerId, name: ps.name, seat: ps.seat, left: !!ps.left, round: this.round,
    }));
    for (const hook of hooks) {
      try { hook(this, { eliminated, round: this.round }); } catch (e) { this.reportError('mod settle hook', e); }
    }
  }
}
