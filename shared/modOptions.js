// shared/modOptions.js — the options a CODE MOD may declare, and the values a room may set for one match (docs/MODS.md).
//
// A mod often has a knob or two ("sum or max?", "per band or per current health?"). Its own `config.json` is the server's
// default, but the host of a room should be able to set it for one match, and the core must be able to check it WITHOUT
// knowing what the knob means — so the mod declares it in `mod.json`:
//
//   "options": {
//     "mode":   { "type": "enum", "values": ["sum", "max"], "default": "sum", "label": "血条大小" },
//     "source": { "type": "enum", "values": ["band", "lp"], "default": "band", "label": "血量来源" }
//   }
//
// `type` is `enum` (with `values`), `number` (with optional `min` / `max`) or `boolean`. Everything here is shared: the
// scanner validates the declaration, the lobby validates a room's values against it, the client renders controls from it and
// the match hands the values to the mod (`Match.modOptions`).

/** The option types a declaration may use. */
export const MOD_OPTION_TYPES = Object.freeze(['enum', 'number', 'boolean']);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate one option declaration. Unknown keys are reported, never silently accepted. `problems` is always present (empty
 * when the declaration is fine) so a caller can report it without a type dance; `option` is set only when `ok` is true.
 * @param {string} key
 * @param {any} spec
 * @returns {{ ok: boolean, option?: { key: string, type: string, values?: (string|number)[], min?: number, max?: number,
 *   default: any, label: string, description: string }, problems: string[] }}
 */
export function cleanModOption(key, spec) {
  const problems = [];
  if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) {
    return { ok: false, problems: [`option "${String(key).slice(0, 32)}" is not a name (letters/digits/_, ≤ 32, letter first)`] };
  }
  if (!isPlainObject(spec)) return { ok: false, problems: [`option "${key}" must be an object`] };
  for (const k of Object.keys(spec)) {
    if (!['type', 'values', 'min', 'max', 'default', 'label', 'description'].includes(k)) problems.push(`option "${key}": "${k}" is not an option field`);
  }
  const type = spec.type;
  if (!MOD_OPTION_TYPES.includes(type)) problems.push(`option "${key}": "type" must be one of ${MOD_OPTION_TYPES.join(' / ')}`);
  const out = {
    key, type,
    default: spec.default,
    label: typeof spec.label === 'string' ? spec.label : '',
    description: typeof spec.description === 'string' ? spec.description : '',
  };
  if (type === 'enum') {
    const values = Array.isArray(spec.values) ? spec.values.filter((v) => typeof v === 'string' || typeof v === 'number') : null;
    if (!values || !values.length) problems.push(`option "${key}": an enum needs a non-empty "values" array of strings or numbers`);
    else if (new Set(values).size !== values.length) problems.push(`option "${key}": "values" has duplicates`);
    else if (spec.values.length !== values.length) problems.push(`option "${key}": "values" may hold only strings and numbers`);
    else out.values = values;
  }
  if (type === 'number') {
    if (spec.min !== undefined && !Number.isFinite(spec.min)) problems.push(`option "${key}": "min" must be a number`);
    else if (spec.min !== undefined) out.min = spec.min;
    if (spec.max !== undefined && !Number.isFinite(spec.max)) problems.push(`option "${key}": "max" must be a number`);
    else if (spec.max !== undefined) out.max = spec.max;
    if (out.min !== undefined && out.max !== undefined && out.min > out.max) problems.push(`option "${key}": "min" is above "max"`);
  }
  if (spec.default === undefined) problems.push(`option "${key}": a "default" is required`);
  else if (!validModOptionValue(out, spec.default)) problems.push(`option "${key}": "default" ${JSON.stringify(spec.default)} does not fit the type`);
  if (problems.length) return { ok: false, problems };
  return { ok: true, option: out, problems };
}

/**
 * Whether one value fits one (already cleaned) option declaration.
 * @param {{ type: string, values?: (string|number)[], min?: number, max?: number }} option
 * @param {unknown} value
 */
export function validModOptionValue(option, value) {
  if (!option) return false;
  if (option.type === 'boolean') return typeof value === 'boolean';
  if (option.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (option.min !== undefined && value < option.min) return false;
    if (option.max !== undefined && value > option.max) return false;
    return true;
  }
  if (option.type === 'enum') return Array.isArray(option.values) && option.values.includes(/** @type {never} */ (value));
  return false;
}

/**
 * Validate a whole `options` declaration (the `mod.json` block). A block that is not an object is a *problem* (the author
 * meant something and it is not readable); one broken option is a *warning* — that option is dropped and the mod keeps
 * working with its own config, because a typo in a knob must not disable a whole mod.
 * @param {any} raw
 * @returns {{ options: Record<string, any>, problems: string[], warnings: string[] }}
 */
export function cleanModOptions(raw) {
  const options = {};
  const problems = [];
  const warnings = [];
  if (raw === undefined) return { options, problems, warnings };
  if (!isPlainObject(raw)) return { options, problems: ['"options" must be an object'], warnings };
  for (const [key, spec] of Object.entries(raw)) {
    const res = cleanModOption(key, spec);
    if (res.ok && res.option) options[key] = res.option;
    else warnings.push(...res.problems);
  }
  return { options, problems, warnings };
}

/** The declared defaults of an options block, as a plain object. */
export function modOptionDefaults(options) {
  const out = {};
  for (const [key, spec] of Object.entries(options || {})) if (spec && spec.default !== undefined) out[key] = spec.default;
  return out;
}

/**
 * Validate the values a room submits for one mod's options. Only declared keys are allowed, and every value must fit its
 * type — an unknown key or an out-of-range value is a refusal, never a silent drop.
 * @param {Record<string, any>} declared the mod's cleaned declaration
 * @param {any} values the room's values
 * @returns {{ ok: true, values: Record<string, any> } | { ok: false, detail: string }}
 */
export function cleanModOptionValues(declared, values) {
  if (values === undefined || values === null) return { ok: true, values: {} };
  if (!isPlainObject(values)) return { ok: false, detail: 'options must be an object' };
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    const spec = (declared || {})[key];
    if (!spec) return { ok: false, detail: `"${String(key).slice(0, 32)}" is not an option of this mod` };
    if (!validModOptionValue(spec, value)) return { ok: false, detail: `"${key}" does not fit ${spec.type}` };
    out[key] = value;
  }
  return { ok: true, values: out };
}
