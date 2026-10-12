// shared/modContent.js — the content hook a CODE MOD registers through (docs/MODS.md §4.6 ②).
//
// An ES module's exports cannot be reassigned, so a mod cannot append itself to the engine's content lists by patching one.
// It registers here instead, and the engine includes these modules AFTER the shipped ones (so a mod's handler for a key
// replaces a built-in's). This file pins that contract: what is accepted, what is refused, and that the engine really sees
// the module in `registerAllMeta`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modContentModules, registerModContent, resetModContent } from '../shared/modContent.js';
import { createRegistry } from '../server/match/effectsMeta.js';

test('a mod content module is accepted, listed in order, and refused when it can do nothing', () => {
  resetModContent();
  try {
    assert.deepEqual(modContentModules(), []);
    assert.throws(() => registerModContent(null), /content module object/);
    assert.throws(() => registerModContent({ name: 'empty' }), /registerMeta/);
    const first = { name: 'first', registerMeta() {} };
    const second = { name: 'second', install() {} };
    assert.equal(registerModContent(first), 1);
    assert.equal(registerModContent(second), 2);
    assert.deepEqual(modContentModules(), [first, second], 'registration order is kept');
    resetModContent();
    assert.deepEqual(modContentModules(), [], 'and it can be reset');
  } finally { resetModContent(); }
});

test('the engine registry runs the mod module after the shipped content, so a mod handler wins', () => {
  resetModContent();
  try {
    const seen = [];
    registerModContent({
      name: 'probe',
      registerMeta(registry) {
        seen.push('mod');
        // registering an engine key that shipped content also claims: the later registration replaces it
        registry.choice('allybuff_select_1', { onChoicePick() { seen.push('mod-handler'); } });
      },
    });
    const registry = createRegistry({ log: { info() {}, warn() {}, error() {} } });
    assert.deepEqual(seen, ['mod'], 'registerMeta ran while the registry was built');
    const handler = registry.get('choice:allybuff_select_1');
    assert.equal(typeof handler.onChoicePick, 'function');
    handler.onChoicePick({}, {});
    assert.deepEqual(seen, ['mod', 'mod-handler'], 'and the mod handler is the one that runs');
  } finally { resetModContent(); }
});
