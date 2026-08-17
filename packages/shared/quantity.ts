// Shared quantity engine — the single implementation used by BOTH apps.
//
// A quantity is a RANGE with an optional unit and optional preparation notes:
//
//   "5-10 cloves, minced"  ->  { min: 5, max: 10, unit: 'clove', prep: ['minced'] }
//
// Modelling it as a bare {value, unit} lost the top of every range (so "5-10"
// silently became 5 and you'd under-buy) and treated preparation words as units
// ("minced" became a unit, so garlic never combined with itself).

import { gramsPerCup, isCountUnit, isPrepWord } from './ingredients';

export type Dimension = 'mass' | 'volume' | 'count';

interface UnitDef {
  unit: string;        // canonical token, always singular — this is what gets STORED
  dimension: Dimension;
  toBase: number;      // multiplier to the dimension's base unit (g for mass, ml for volume)
  aliases: RegExp;     // anchored, matches a whole unit token
  plural?: string;     // display-only; never stored
  /** Cooks read these in fractions (1⅛ cups), not decimals (1.13 cups). */
  fractional?: boolean;
}

// Base units: mass = g, volume = ml.
const UNIT_DEFS: UnitDef[] = [
  { unit: 'g',     dimension: 'mass',   toBase: 1,       aliases: /^(g|gr|grams?|gramme?s?)$/i },
  { unit: 'kg',    dimension: 'mass',   toBase: 1000,    aliases: /^(kg|kgs|kilos?|kilograms?)$/i },
  { unit: 'oz',    dimension: 'mass',   toBase: 28.3495, aliases: /^(oz|ozs|ounces?)$/i },
  { unit: 'lb',    dimension: 'mass',   toBase: 453.592, aliases: /^(lb|lbs|pounds?)$/i },
  { unit: 'ml',    dimension: 'volume', toBase: 1,       aliases: /^(ml|mls|milliliters?|millilitres?)$/i },
  { unit: 'l',     dimension: 'volume', toBase: 1000,    aliases: /^(l|liters?|litres?)$/i },
  { unit: 'tsp',   dimension: 'volume', toBase: 4.92892, aliases: /^(tsp|tsps|teaspoons?)$/i, fractional: true },
  { unit: 'tbsp',  dimension: 'volume', toBase: 14.7868, aliases: /^(tbsp|tbsps|tbs|tablespoons?)$/i, fractional: true },
  { unit: 'fl oz', dimension: 'volume', toBase: 29.5735, aliases: /^(floz|fluidounces?)$/i, plural: 'fl oz' },
  { unit: 'cup',   dimension: 'volume', toBase: 236.588, aliases: /^(cups?|c)$/i, plural: 'cups', fractional: true },
];

const ML_PER_CUP = 236.588;

const UNICODE_FRACTIONS: Record<string, number> = {
  '¼': 1 / 4, '½': 1 / 2, '¾': 3 / 4,
  '⅓': 1 / 3, '⅔': 2 / 3,
  '⅕': 1 / 5, '⅖': 2 / 5, '⅗': 3 / 5, '⅘': 4 / 5,
  '⅙': 1 / 6, '⅚': 5 / 6,
  '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8,
};
const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('');

// Fractions a cook would actually write, for display.
const DISPLAY_FRACTIONS: [number, string][] = [
  [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'],
  [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞'],
];

// "1 1/2" | "1/2" | "1.5" | ".5" | "1½" | "½" | "1"
export const VALUE_PATTERN =
  `(?:\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+\\s*/\\s*\\d+|\\d*\\.\\d+|\\d*\\s*[${FRACTION_CHARS}]|\\d+)`;

const RANGE_SEP = `\\s*(?:-|–|—|to)\\s*`;
// A leading amount (optionally a range), then anything else — unit and/or prep.
const QUANTITY_RE = new RegExp(`^(${VALUE_PATTERN})(?:${RANGE_SEP}(${VALUE_PATTERN}))?(.*)$`);

export interface ParsedQuantity {
  /** Low end of the range. Equals max for a plain scalar. */
  min: number;
  /** High end of the range. Equals min for a plain scalar. */
  max: number;
  /** Alias of `min`, kept so existing single-value call sites keep working. */
  value: number;
  /** canonical unit if known, lowercased raw token if not, null if unitless */
  unit: string | null;
  /** true when the unit is in the conversion table (or the value is unitless) */
  known: boolean;
  dimension: Dimension | null;
  /** Preparation notes stripped out of the quantity ("minced", "packed"). */
  prep: string[];
}

/**
 * Folds shapes real recipe text and LLM output produce into something parseable:
 * compound units and decimal commas. Ranges are deliberately NOT collapsed here
 * — the parser keeps both ends.
 */
export function preNormalize(raw: string): string {
  return raw
    .trim()
    .replace(/\bfl\.?\s*(?:oz|ounces?)\b/gi, 'floz')
    .replace(/\bfluid\s+ounces?\b/gi, 'floz')
    .replace(/(\d),(\d)/g, '$1.$2')
    .trim();
}

export function normalizeUnit(token: string | null | undefined): UnitDef | null {
  if (!token) return null;
  const trimmed = token.trim().replace(/\.$/, '');
  if (!trimmed) return null;
  return UNIT_DEFS.find((def) => def.aliases.test(trimmed)) ?? null;
}

/** Singularizes an unknown unit token so "clove"/"cloves" aggregate together. */
export function singularizeUnit(unit: string): string {
  const u = unit.toLowerCase();
  if (/ies$/.test(u)) return u.replace(/ies$/, 'y');
  if (/(?:s|x|z|ch|sh)es$/.test(u)) return u.replace(/es$/, '');
  if (/s$/.test(u) && !/ss$/.test(u)) return u.replace(/s$/, '');
  return u;
}

export function parseValueToken(token: string): number | null {
  const t = token.trim();
  if (!t) return null;

  const unicodeMatch = t.match(new RegExp(`^(\\d+)?\\s*([${FRACTION_CHARS}])$`));
  if (unicodeMatch) {
    const whole = unicodeMatch[1] ? parseInt(unicodeMatch[1], 10) : 0;
    return whole + (UNICODE_FRACTIONS[unicodeMatch[2]!] ?? 0);
  }

  const fractionMatch = t.match(/^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/);
  if (fractionMatch) {
    const whole = fractionMatch[1] ? parseInt(fractionMatch[1]!, 10) : 0;
    const den = parseInt(fractionMatch[3]!, 10);
    if (!den) return null;
    return whole + parseInt(fractionMatch[2]!, 10) / den;
  }

  const num = Number(t);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parses a freeform quantity: "1 1/2 cups", "200g", "5-10 cloves, minced",
 * "8 fl oz", "3". Returns null when the string isn't quantity-shaped.
 */
export function parseQuantity(raw?: string | null): ParsedQuantity | null {
  if (!raw) return null;
  const match = preNormalize(raw).match(QUANTITY_RE);
  if (!match) return null;

  const min = parseValueToken(match[1]!);
  if (min === null) return null;
  let max = match[2] ? parseValueToken(match[2]) ?? min : min;
  if (max < min) max = min;

  // Everything after the amount is a unit and/or preparation notes, in any
  // order and with any punctuation: "cloves, minced", "minced", "cloves".
  const tail = match[3] ?? '';

  // A second number in the tail means this is a compound expression, not a
  // quantity — "1 cup or 200g", "2 cups (500 ml)". Bail so it passes through
  // intact rather than silently becoming "1 cup".
  if (/\d/.test(tail)) return null;

  const tokens = tail.split(/[^a-zA-Z]+/).filter(Boolean);
  const prep: string[] = [];
  let unitToken: string | null = null;
  for (const token of tokens) {
    // A real unit wins over the prep vocabulary — several words are in both
    // ("slice", "dice", "cube"), and treating "1 slice" as a preparation while
    // "2 slices" parsed as a unit meant the two never combined.
    const isUnitish = !!normalizeUnit(token) || isCountUnit(singularizeUnit(token));
    if (unitToken === null && isUnitish) { unitToken = token; continue; }
    if (isPrepWord(token)) { prep.push(token.toLowerCase()); continue; }
    if (unitToken === null) { unitToken = token; continue; }
    // Unrecognised word once a unit is already claimed — ambiguous, don't guess.
    return null;
  }

  const base = { min, max, value: min, prep };

  if (!unitToken) return { ...base, unit: null, known: true, dimension: 'count' };

  const def = normalizeUnit(unitToken);
  if (def) return { ...base, unit: def.unit, known: true, dimension: def.dimension };

  const singular = singularizeUnit(unitToken);
  // Count units are "known" in the sense that they combine cleanly — they just
  // never convert to mass or volume.
  return {
    ...base,
    unit: singular,
    known: isCountUnit(singular),
    dimension: isCountUnit(singular) ? 'count' : null,
  };
}

/** Converts between two known units of the same dimension, else null. */
export function convert(value: number, fromUnit: string, toUnit: string): number | null {
  const from = UNIT_DEFS.find((d) => d.unit === fromUnit);
  const to = UNIT_DEFS.find((d) => d.unit === toUnit);
  if (!from || !to || from.dimension !== to.dimension) return null;
  return (value * from.toBase) / to.toBase;
}

export function formatValue(n: number): string {
  return String(parseFloat(n.toFixed(2)));
}

/**
 * A number a cook would write. Imperial volumes and counts snap to familiar
 * fractions — "1⅛ cups" rather than "1.13 cups" — and metric rounds to a
 * sensible precision instead of carrying false decimals.
 */
/**
 * The number formatFriendlyValue will actually show, as a number. Pluralisation
 * has to agree with what's on screen: 1 cup + 2 tsp is 1.0416 cups but displays
 * as "1", so testing the raw value gave "1 cups".
 */
function snapNumeric(n: number, unit: string | null): number {
  const def = unit ? UNIT_DEFS.find((d) => d.unit === unit) : null;
  if (def && !def.fractional) {
    if (n >= 100) return Math.round(n);
    if (n >= 10) return Math.round(n * 10) / 10;
    return parseFloat(n.toFixed(2));
  }
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  let best = 0;
  let bestDist = frac;
  for (const [val] of DISPLAY_FRACTIONS) {
    const d = Math.abs(frac - val);
    if (d < bestDist) { bestDist = d; best = val; }
  }
  if (1 - frac < bestDist) return whole + 1;
  return whole + best;
}

export function formatFriendlyValue(n: number, unit: string | null): string {
  const def = unit ? UNIT_DEFS.find((d) => d.unit === unit) : null;
  // Counts, unknown units and imperial volumes all read better as fractions.
  const useFractions = !def || def.fractional;

  if (useFractions) {
    const whole = Math.floor(n + 1e-9);
    const frac = n - whole;

    // Snap to the NEAREST fraction a cook would write — including 0 and 1 — so
    // the result is never a decimal. A tolerance-based match left near-misses
    // like 1.04 cups (1 cup + 2 tsp) rendering as "1.04", when the honest
    // grocery answer is "1 cup": 2 tsp is noise you don't shop for.
    let best = 0;
    let bestDist = frac;
    for (const [val] of DISPLAY_FRACTIONS) {
      const d = Math.abs(frac - val);
      if (d < bestDist) { bestDist = d; best = val; }
    }
    if (1 - frac < bestDist) return String(whole + 1);
    if (best === 0) return String(whole);

    const glyph = DISPLAY_FRACTIONS.find(([v]) => v === best)![1];
    return whole > 0 ? `${whole}${glyph}` : glyph;
  }

  // Metric and weight: round by magnitude, no invented precision.
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return String(Math.round(n * 10) / 10);
  return formatValue(n);
}

/** Symbols and abbreviations don't take a plural: "2 g", "3 tsp", not "3 tsps". */
const INVARIANT_UNITS = new Set(['g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'fl oz']);

function pluralizeUnit(unit: string, def?: UnitDef | null): string {
  if (def?.plural) return def.plural;
  if (INVARIANT_UNITS.has(unit)) return unit;
  if (/(?:s|x|z|ch|sh)$/.test(unit)) return `${unit}es`;   // bunch -> bunches
  if (/[^aeiou]y$/.test(unit)) return unit.replace(/y$/, 'ies');
  return `${unit}s`;
}

/** Canonical, singular — this is the form that gets STORED. */
export function formatQuantity(value: number, unit: string | null): string {
  if (!unit) return formatValue(value);
  return `${formatValue(value)} ${unit}`;
}

/** Display-only, pluralized and range-aware. Never persist this. */
export function formatQuantityDisplay(value: number, unit: string | null, max?: number): string {
  const hi = max ?? value;
  const def = unit ? UNIT_DEFS.find((d) => d.unit === unit) : null;
  const amount = hi > value
    ? `${formatFriendlyValue(value, unit)}–${formatFriendlyValue(hi, unit)}`
    : formatFriendlyValue(value, unit);
  if (!unit) return amount;
  const plural = pluralizeUnit(unit, def);
  // English keeps the singular at or below one — "¾ cup", not "¾ cups".
  const display = snapNumeric(hi, unit) > 1 ? plural : unit;
  return `${amount} ${display}`;
}

/**
 * Normalizes a freeform quantity to canonical stored form:
 * "1 ½ cups" → "1.5 cup", "3 tsp." → "3 tsp", "5-10 cloves, minced" → "5-10 clove".
 * Preparation notes are dropped — they belong on the item name, not the amount.
 * Strings that aren't quantity-shaped ("to taste") pass through unchanged.
 */
export function normalizeQuantity(quantity: unknown): string {
  if (typeof quantity !== 'string') return '';
  const trimmed = quantity.trim();
  if (!trimmed) return '';

  const parsed = parseQuantity(trimmed);
  if (!parsed) return trimmed;

  const amount = parsed.max > parsed.min
    ? `${formatValue(parsed.min)}-${formatValue(parsed.max)}`
    : formatValue(parsed.min);

  return parsed.unit ? `${amount} ${parsed.unit}` : amount;
}

export function normalizeIngredients<T extends { quantity?: unknown }>(
  ingredients: T[] | undefined | null
): T[] {
  if (!Array.isArray(ingredients)) return [];
  return ingredients.map((ing) => ({ ...ing, quantity: normalizeQuantity(ing?.quantity) }));
}

/** The cycle order shown by the unit-swap button, restricted to one dimension. */
export function unitCycle(unit: string): string[] {
  const def = UNIT_DEFS.find((d) => d.unit === unit);
  if (!def) return [];
  return UNIT_DEFS.filter((d) => d.dimension === def.dimension).map((d) => d.unit);
}

/** Most common unit in a group; ties break toward the coarser unit, then a–z. */
function pickTargetUnit(units: string[]): string | null {
  if (units.length === 0) return null;
  const counts = new Map<string, number>();
  for (const u of units) counts.set(u, (counts.get(u) ?? 0) + 1);
  const toBase = (u: string) => UNIT_DEFS.find((d) => d.unit === u)?.toBase ?? 0;

  return [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const tb = toBase(b[0]) - toBase(a[0]);
    if (tb !== 0) return tb;
    return a[0].localeCompare(b[0]);
  })[0]![0];
}

/** Promotes to the unit a human would use: 1200 g → 1.2 kg, 1500 ml → 1.5 l. */
function promoteUnit(min: number, max: number, unit: string | null): { min: number; max: number; unit: string | null } {
  if (unit === 'g' && min >= 1000) return { min: min / 1000, max: max / 1000, unit: 'kg' };
  if (unit === 'ml' && min >= 1000) return { min: min / 1000, max: max / 1000, unit: 'l' };
  if (unit === 'kg' && max < 1) return { min: min * 1000, max: max * 1000, unit: 'g' };
  if (unit === 'l' && max < 1) return { min: min * 1000, max: max * 1000, unit: 'ml' };
  return { min, max, unit };
}

interface Group {
  /** Units seen, used only to choose how to display the total. */
  units: string[];
  /**
   * Running totals. For mass/volume these are in the dimension's BASE unit
   * (g / ml) — converted on the way in, because summing mixed units and trying
   * to convert afterwards loses which member contributed what.
   */
  min: number;
  max: number;
  dimension: Dimension | null;
}

/**
 * Aggregates quantity strings into one display total.
 *
 * Pass `ingredientName` to unlock mass↔volume merging: "1 cup flour" + "10 g
 * flour" can only combine if we know what a cup of flour weighs. Without it,
 * the two stay separate terms — correct, just less useful.
 *
 * Ranges add end to end (2 + 5–10 = 7–12). Counts never convert to weight.
 * Strings that don't parse at all ("to taste") are carried through as literals
 * rather than dropped.
 */
export function aggregateQuantities(
  rawQuantities: (string | undefined)[],
  ingredientName?: string | null
): string {
  const groups = new Map<string, Group>();
  const literals: string[] = [];

  for (const raw of rawQuantities) {
    const parsed = parseQuantity(raw);
    if (!parsed) {
      const literal = typeof raw === 'string' ? raw.trim() : '';
      if (literal) literals.push(literal);
      continue;
    }

    let key: string;
    if (parsed.dimension === 'mass' || parsed.dimension === 'volume') key = `dim:${parsed.dimension}`;
    else if (parsed.unit) key = `count:${parsed.unit}`;
    else key = 'count';

    const group = groups.get(key) ?? { units: [], min: 0, max: 0, dimension: parsed.dimension };
    if (parsed.unit) group.units.push(parsed.unit);

    // Mass/volume accumulate in the base unit; counts accumulate as-is.
    const scale = parsed.dimension === 'mass' || parsed.dimension === 'volume'
      ? UNIT_DEFS.find((d) => d.unit === parsed.unit)?.toBase ?? 1
      : 1;
    group.min += parsed.min * scale;
    group.max += parsed.max * scale;
    groups.set(key, group);
  }

  // Merge mass and volume when we know what a cup of this ingredient weighs.
  const mass = groups.get('dim:mass');
  const volume = groups.get('dim:volume');
  if (mass && volume) {
    const gpc = gramsPerCup(ingredientName);
    if (gpc) {
      const gPerMl = gpc / ML_PER_CUP;
      // Fold into whichever dimension the recipes mostly used.
      if (volume.units.length >= mass.units.length) {
        volume.min += mass.min / gPerMl;   // g -> ml
        volume.max += mass.max / gPerMl;
        volume.units.push(...mass.units.map(() => pickTargetUnit(volume.units) ?? 'cup'));
        groups.delete('dim:mass');
      } else {
        mass.min += volume.min * gPerMl;   // ml -> g
        mass.max += volume.max * gPerMl;
        groups.delete('dim:volume');
      }
    }
  }

  const terms: string[] = [];
  for (const [key, group] of groups) {
    if (key.startsWith('dim:')) {
      const target = pickTargetUnit(group.units) ?? (group.dimension === 'mass' ? 'g' : 'ml');
      const toBase = UNIT_DEFS.find((d) => d.unit === target)?.toBase ?? 1;
      const p = promoteUnit(group.min / toBase, group.max / toBase, target);
      terms.push(formatQuantityDisplay(p.min, p.unit, p.max));
    } else if (key === 'count') {
      terms.push(formatQuantityDisplay(group.min, null, group.max));
    } else {
      terms.push(formatQuantityDisplay(group.min, group.units[0] ?? null, group.max));
    }
  }

  return [...terms, ...literals].join(' + ');
}

/**
 * True when two quantity strings mean the same thing. Compare with this rather
 * than `a === b` when deciding whether a stored snapshot is still current —
 * string equality also fails on cosmetic differences ("2 cup" vs "2 cups").
 */
export function quantitiesEquivalent(a?: string | null, b?: string | null): boolean {
  const rawA = (a ?? '').trim();
  const rawB = (b ?? '').trim();
  if (rawA === rawB) return true;

  const pa = parseQuantity(rawA);
  const pb = parseQuantity(rawB);
  if (!pa || !pb) return false;

  const unitA = pa.unit ? singularizeUnit(pa.unit) : null;
  const unitB = pb.unit ? singularizeUnit(pb.unit) : null;
  if (unitA !== unitB) return false;

  return Math.abs(pa.min - pb.min) < 0.005 && Math.abs(pa.max - pb.max) < 0.005;
}

/**
 * Splits an item's text into a quantity and the remaining name.
 * "2 cups flour" → { quantity: "2 cup", text: "flour" }
 * "2 chicken breasts" → { quantity: "2", text: "chicken breasts" }
 */
export function parseQuantityAndText(text: string): { quantity: string | null; text: string } {
  if (!text) return { quantity: null, text: '' };
  const trimmed = preNormalize(text);

  const startMatch = trimmed.match(new RegExp(`^(${VALUE_PATTERN})\\s*([a-zA-Z]+\\.?)?\\s+(.+)$`));
  if (startMatch) {
    const value = parseValueToken(startMatch[1]!);
    if (value !== null) {
      const unitDef = normalizeUnit(startMatch[2]);
      if (unitDef) return { quantity: formatQuantity(value, unitDef.unit), text: startMatch[3]! };
      const rest = [startMatch[2], startMatch[3]].filter(Boolean).join(' ');
      return { quantity: formatValue(value), text: rest };
    }
  }

  const endMatch = trimmed.match(new RegExp(`^(.+?)\\s+(${VALUE_PATTERN})\\s*([a-zA-Z]+\\.?)?$`));
  if (endMatch) {
    const value = parseValueToken(endMatch[2]!);
    const unitDef = normalizeUnit(endMatch[3]);
    if (value !== null && (unitDef || !endMatch[3])) {
      if (!unitDef && /^\d{4}$/.test(endMatch[2]!.trim())) {
        return { quantity: null, text: trimmed };
      }
      return {
        quantity: unitDef ? formatQuantity(value, unitDef.unit) : formatValue(value),
        text: endMatch[1]!,
      };
    }
  }

  return { quantity: null, text: trimmed };
}
