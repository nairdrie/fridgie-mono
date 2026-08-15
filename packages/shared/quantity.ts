// Shared quantity engine — the single implementation used by BOTH apps.
//
// Previously the server had a normalize-only copy and the client a full
// parse/convert/format/aggregate copy, written independently. They disagreed on
// plurals ("2 cup" vs "2 cups"), on unit aliases, on trailing periods ("3 tsp."),
// and on rounding, so values the server stored were silently dropped by the
// client aggregator. Environment-neutral: no platform APIs, no dependencies.

export type Dimension = 'mass' | 'volume' | 'count';

interface UnitDef {
  unit: string;        // canonical token, always singular — this is what gets STORED
  dimension: Dimension;
  toBase: number;      // multiplier to the dimension's base unit (g for mass, ml for volume)
  aliases: RegExp;     // anchored, matches a whole unit token
  plural?: string;     // display-only; never stored
}

// Base units: mass = g, volume = ml.
const UNIT_DEFS: UnitDef[] = [
  { unit: 'g',     dimension: 'mass',   toBase: 1,       aliases: /^(g|gr|grams?|gramme?s?)$/i },
  { unit: 'kg',    dimension: 'mass',   toBase: 1000,    aliases: /^(kg|kgs|kilos?|kilograms?)$/i },
  { unit: 'oz',    dimension: 'mass',   toBase: 28.3495, aliases: /^(oz|ozs|ounces?)$/i },
  { unit: 'lb',    dimension: 'mass',   toBase: 453.592, aliases: /^(lb|lbs|pounds?)$/i },
  { unit: 'ml',    dimension: 'volume', toBase: 1,       aliases: /^(ml|mls|milliliters?|millilitres?)$/i },
  { unit: 'l',     dimension: 'volume', toBase: 1000,    aliases: /^(l|liters?|litres?)$/i },
  { unit: 'tsp',   dimension: 'volume', toBase: 4.92892, aliases: /^(tsp|tsps|teaspoons?)$/i },
  { unit: 'tbsp',  dimension: 'volume', toBase: 14.7868, aliases: /^(tbsp|tbsps|tbs|tablespoons?)$/i },
  { unit: 'fl oz', dimension: 'volume', toBase: 29.5735, aliases: /^(floz|fluidounces?)$/i, plural: 'fl oz' },
  { unit: 'cup',   dimension: 'volume', toBase: 236.588, aliases: /^(cups?|c)$/i, plural: 'cups' },
];

const UNICODE_FRACTIONS: Record<string, number> = {
  '¼': 1 / 4, '½': 1 / 2, '¾': 3 / 4,
  '⅓': 1 / 3, '⅔': 2 / 3,
  '⅕': 1 / 5, '⅖': 2 / 5, '⅗': 3 / 5, '⅘': 4 / 5,
  '⅙': 1 / 6, '⅚': 5 / 6,
  '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8,
};
const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('');

// "1 1/2" | "1/2" | "1.5" | ".5" | "1½" | "½" | "1"
export const VALUE_PATTERN =
  `(?:\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+\\s*/\\s*\\d+|\\d*\\.\\d+|\\d*\\s*[${FRACTION_CHARS}]|\\d+)`;

// A unit token may carry a trailing period ("3 tsp.") — both sides now accept it.
const UNIT_TOKEN = `([a-zA-Z]+\\.?)?`;
const QUANTITY_RE = new RegExp(`^(${VALUE_PATTERN})\\s*${UNIT_TOKEN}\\s*$`);

export interface ParsedQuantity {
  value: number;
  /** canonical unit if known, lowercased raw token if not, null if unitless */
  unit: string | null;
  /** true when the unit is in the conversion table (or the value is unitless) */
  known: boolean;
  dimension: Dimension | null;
}

/**
 * Folds the shapes real recipe text and LLM output produce into something the
 * single parser below can read: compound units, decimal commas, and ranges
 * (which collapse to their lower bound, matching the importer's prompt rule).
 */
export function preNormalize(raw: string): string {
  return raw
    .trim()
    .replace(/\bfl\.?\s*(?:oz|ounces?)\b/gi, 'floz')
    .replace(/\bfluid\s+ounces?\b/gi, 'floz')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/^(\d+(?:\.\d+)?)\s*[-–—]\s*\d+(?:\.\d+)?/, '$1')
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
 * Parses a freeform quantity like "1 1/2 cups", "200g", "½ tsp", "8 fl oz", "3".
 * Returns null when the string isn't quantity-shaped ("to taste", "1 large").
 */
export function parseQuantity(raw?: string | null): ParsedQuantity | null {
  if (!raw) return null;
  const match = preNormalize(raw).match(QUANTITY_RE);
  if (!match) return null;

  const value = parseValueToken(match[1]!);
  if (value === null) return null;

  const unitToken = match[2]?.replace(/\.$/, '');
  if (!unitToken) return { value, unit: null, known: true, dimension: 'count' };

  const def = normalizeUnit(unitToken);
  if (def) return { value, unit: def.unit, known: true, dimension: def.dimension };

  return { value, unit: unitToken.toLowerCase(), known: false, dimension: null };
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

/** Canonical, singular — this is the form that gets STORED and compared. */
export function formatQuantity(value: number, unit: string | null): string {
  if (!unit) return formatValue(value);
  return `${formatValue(value)} ${unit}`;
}

/** Display-only, pluralized. Never persist this. */
export function formatQuantityDisplay(value: number, unit: string | null): string {
  if (!unit) return formatValue(value);
  const def = UNIT_DEFS.find((d) => d.unit === unit);
  const display = def?.plural && value !== 1 ? def.plural : unit;
  return `${formatValue(value)} ${display}`;
}

/**
 * Normalizes a freeform quantity to the canonical "<decimal> <unit>" form:
 * "1 ½ cups" → "1.5 cup", "200g" → "200 g", "3 tsp." → "3 tsp",
 * "2-3 cups" → "2 cup", "8 fl oz" → "8 fl oz".
 * Strings that aren't quantity-shaped ("to taste") pass through unchanged.
 */
export function normalizeQuantity(quantity: unknown): string {
  if (typeof quantity !== 'string') return '';
  const trimmed = quantity.trim();
  if (!trimmed) return '';

  const parsed = parseQuantity(trimmed);
  if (!parsed) return trimmed;

  // Unknown unit ("2 bunches") — keep the value canonical but preserve the token.
  if (!parsed.known && parsed.unit) return `${formatValue(parsed.value)} ${parsed.unit}`;

  return formatQuantity(parsed.value, parsed.unit);
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

/**
 * Picks a group's display unit deterministically: the most common unit among
 * its members, tie-broken toward the coarser unit then alphabetically. Chosen
 * so the total no longer depends on the order items happen to sit in the array
 * (which the server controls, by appending meal ingredients at the end).
 */
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

/**
 * Aggregates quantity strings into one display total.
 *
 * Known units combine within their dimension; unknown units group by their
 * singularized token; unitless values sum. Strings that don't parse at all
 * ("to taste") are carried through as literal terms rather than dropped — the
 * server deliberately stores those, and silently discarding them understated
 * grocery totals and hid the quantity chip entirely.
 */
export function aggregateQuantities(rawQuantities: (string | undefined)[]): string {
  type Group = { units: string[]; values: number[]; known: boolean; unit: string | null };
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
    if (parsed.known && parsed.unit) key = `dim:${parsed.dimension}`;
    else if (parsed.unit) key = `raw:${singularizeUnit(parsed.unit)}`;
    else key = 'count';

    let group = groups.get(key);
    if (!group) {
      group = { units: [], values: [], known: parsed.known, unit: parsed.unit };
      groups.set(key, group);
    }
    if (parsed.unit) group.units.push(parsed.unit);
    group.values.push(parsed.value);
  }

  const terms: string[] = [];

  for (const group of groups.values()) {
    if (!group.known || group.units.length === 0) {
      // Unknown unit or unitless — plain sum, token preserved.
      const sum = group.values.reduce((a, b) => a + b, 0);
      const unit = group.units.length ? singularizeUnit(group.units[0]!) : null;
      terms.push(unit ? `${formatValue(sum)} ${unit}` : formatValue(sum));
      continue;
    }

    const target = pickTargetUnit(group.units)!;
    let total = 0;
    for (let i = 0; i < group.values.length; i++) {
      const from = group.units[i]!;
      total += convert(group.values[i]!, from, target) ?? group.values[i]!;
    }
    terms.push(formatQuantityDisplay(total, target));
  }

  return [...terms, ...literals].join(' + ');
}

/**
 * Splits an item's text into a quantity and the remaining name.
 * "2 cups flour" → { quantity: "2 cup", text: "flour" }
 * "2 chicken breasts" → { quantity: "2", text: "chicken breasts" }
 */
export function parseQuantityAndText(text: string): { quantity: string | null; text: string } {
  if (!text) return { quantity: null, text: '' };
  const trimmed = preNormalize(text);

  const startMatch = trimmed.match(new RegExp(`^(${VALUE_PATTERN})\\s*${UNIT_TOKEN}\\s+(.+)$`));
  if (startMatch) {
    const value = parseValueToken(startMatch[1]!);
    if (value !== null) {
      const unitDef = normalizeUnit(startMatch[2]);
      if (unitDef) return { quantity: formatQuantity(value, unitDef.unit), text: startMatch[3]! };
      // Unknown token after the number ("2 chicken breasts") — part of the name.
      const rest = [startMatch[2], startMatch[3]].filter(Boolean).join(' ');
      return { quantity: formatValue(value), text: rest };
    }
  }

  const endMatch = trimmed.match(new RegExp(`^(.+?)\\s+(${VALUE_PATTERN})\\s*${UNIT_TOKEN}$`));
  if (endMatch) {
    const value = parseValueToken(endMatch[2]!);
    const unitDef = normalizeUnit(endMatch[3]);
    if (value !== null && (unitDef || !endMatch[3])) {
      // Bare 4-digit trailing numbers are more likely years/labels than quantities.
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
