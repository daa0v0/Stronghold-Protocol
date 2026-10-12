// The room-size POLICY is a data pack now (packs/capacity-20/, docs/MODS.md): the base table `data/capacity.json` is the
// upstream baseline (four players, one pool) and the pack carries the 4/8/10/16/20 policy.
//
// A test that starts a server gets this for free (server/index.js applies whatever the packs produced at boot). A test that
// exercises the rules directly — poolGroupSizes, uniteRoundLimit, the lobby's option list — calls `useCapacityPack()` so it
// tests the policy this repository ships, rather than the baseline it falls back to without the pack.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCapacityRules } from '../../shared/playerCapacity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Apply the shipped 20-player policy. Returns what applyCapacityRules reports (throwing if the pack is malformed). */
export function useCapacityPack() {
  const patch = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs', 'capacity-20', 'patch.json'), 'utf8'));
  const result = applyCapacityRules(patch.capacity);
  if (result.rejected.length) throw new Error(`packs/capacity-20 is malformed: ${result.rejected.join(', ')}`);
  return result;
}
