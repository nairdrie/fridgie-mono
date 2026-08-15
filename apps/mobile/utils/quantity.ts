// utils/quantity.ts
//
// Single source of truth for parsing, converting, formatting, and aggregating
// ingredient quantities. Quantities are stored as freeform strings on Item/Ingredient
// (see BACKEND_HANDOFF.md §5.1 for the planned structured model); this module is the
// only place that should interpret those strings.

export type Dimension = 'mass' | 'volume' | 'count';

interface UnitDef {
    unit: string;            // canonical name
    dimension: Dimension;
    toBase: number;          // multiplier to base unit (g for mass, ml for volume)
    aliases: RegExp;         // anchored, matches the whole unit token
    plural?: string;
}

// Base units: mass = g, volume = ml.
const UNIT_DEFS: UnitDef[] = [
    { unit: 'g',    dimension: 'mass',   toBase: 1,        aliases: /^(g|grams?|gr)$/i },
    { unit: 'kg',   dimension: 'mass',   toBase: 1000,     aliases: /^(kg|kgs|kilos?|kilograms?)$/i },
    { unit: 'oz',   dimension: 'mass',   toBase: 28.3495,  aliases: /^(oz|ounces?)$/i },
    { unit: 'lb',   dimension: 'mass',   toBase: 453.592,  aliases: /^(lb|lbs|pounds?)$/i },
    { unit: 'ml',   dimension: 'volume', toBase: 1,        aliases: /^(ml|mls|milliliters?|millilitres?)$/i },
    { unit: 'l',    dimension: 'volume', toBase: 1000,     aliases: /^(l|liters?|litres?)$/i },
    { unit: 'tsp',  dimension: 'volume', toBase: 4.92892,  aliases: /^(tsp|tsps|teaspoons?)$/i },
    { unit: 'tbsp', dimension: 'volume', toBase: 14.7868,  aliases: /^(tbsp|tbsps|tbs|tablespoons?)$/i },
    { unit: 'cup',  dimension: 'volume', toBase: 236.588,  aliases: /^(cups?|c)$/i, plural: 'cups' },
];

const UNICODE_FRACTIONS: Record<string, number> = {
    '¼': 0.25, '½': 0.5, '¾': 0.75,
    '⅓': 1 / 3, '⅔': 2 / 3,
    '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
    '⅙': 1 / 6, '⅚': 5 / 6,
    '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};
const UNICODE_FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('');

// Matches: "1 1/2", "1/2", "1.5", "1", "1½", "½"
const VALUE_PATTERN = `(?:\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+\\s*/\\s*\\d+|\\d*\\.\\d+|\\d+\\s*[${UNICODE_FRACTION_CHARS}]|\\d+|[${UNICODE_FRACTION_CHARS}])`;

export interface ParsedQuantity {
    value: number;
    unit: string | null;       // canonical unit if known, lowercased raw token if not, null if unitless
    known: boolean;             // true when unit is in the conversion table (or unitless)
    dimension: Dimension | null;
}

export function normalizeUnit(token: string | null | undefined): UnitDef | null {
    if (!token) return null;
    const trimmed = token.trim();
    if (!trimmed) return null;
    return UNIT_DEFS.find(def => def.aliases.test(trimmed)) ?? null;
}

export function parseValueToken(token: string): number | null {
    const t = token.trim();
    if (!t) return null;

    // "1½" / "½"
    const unicodeMatch = t.match(new RegExp(`^(\\d+)?\\s*([${UNICODE_FRACTION_CHARS}])$`));
    if (unicodeMatch) {
        const whole = unicodeMatch[1] ? parseInt(unicodeMatch[1], 10) : 0;
        return whole + UNICODE_FRACTIONS[unicodeMatch[2]];
    }

    // "1 1/2" / "1/2"
    const fractionMatch = t.match(/^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/);
    if (fractionMatch) {
        const whole = fractionMatch[1] ? parseInt(fractionMatch[1], 10) : 0;
        const den = parseInt(fractionMatch[3], 10);
        if (den === 0) return null;
        return whole + parseInt(fractionMatch[2], 10) / den;
    }

    const num = Number(t);
    return Number.isFinite(num) ? num : null;
}

/**
 * Parses a freeform quantity string like "1 1/2 cups", "200g", "½ tsp", "3".
 * Returns null when the string doesn't start with a number (e.g. "to taste").
 */
export function parseQuantity(raw?: string | null): ParsedQuantity | null {
    if (!raw) return null;
    const match = raw.trim().match(new RegExp(`^(${VALUE_PATTERN})\\s*([a-zA-Z]+)?\\s*$`));
    if (!match) return null;
    const value = parseValueToken(match[1]);
    if (value === null) return null;

    const unitToken = match[2];
    if (!unitToken) {
        return { value, unit: null, known: true, dimension: 'count' };
    }
    const def = normalizeUnit(unitToken);
    if (def) {
        return { value, unit: def.unit, known: true, dimension: def.dimension };
    }
    return { value, unit: unitToken.toLowerCase(), known: false, dimension: null };
}

/** Converts between two known units of the same dimension. Returns null if not possible. */
export function convert(value: number, fromUnit: string, toUnit: string): number | null {
    const from = UNIT_DEFS.find(d => d.unit === fromUnit);
    const to = UNIT_DEFS.find(d => d.unit === toUnit);
    if (!from || !to || from.dimension !== to.dimension) return null;
    return (value * from.toBase) / to.toBase;
}

export function formatValue(value: number): string {
    const rounded = parseFloat(value.toFixed(2));
    return String(rounded);
}

export function formatQuantity(value: number, unit: string | null): string {
    if (!unit) return formatValue(value);
    const def = UNIT_DEFS.find(d => d.unit === unit);
    const display = def?.plural && value !== 1 ? def.plural : unit;
    return `${formatValue(value)} ${display}`;
}

/** The cycle order shown by the unit-swap button, restricted to the same dimension. */
export function unitCycle(unit: string): string[] {
    const def = UNIT_DEFS.find(d => d.unit === unit);
    if (!def) return [];
    return UNIT_DEFS.filter(d => d.dimension === def.dimension).map(d => d.unit);
}

/**
 * Aggregates several quantity strings into one display total.
 * Known units are converted into the unit of the first quantity of their
 * dimension (so "200 g" + "2 tsp" stays separate, but "1 cup" + "2 tbsp"
 * becomes "1.13 cups"). Unknown units group by their literal token; unitless
 * values sum together. Unparseable strings are ignored.
 */
export function aggregateQuantities(rawQuantities: (string | undefined)[]): string {
    type Group = { targetUnit: string | null; baseSum: number; known: boolean };
    const groups = new Map<string, Group>();

    for (const raw of rawQuantities) {
        const parsed = parseQuantity(raw);
        if (!parsed) continue;

        let key: string;
        if (parsed.known && parsed.unit) {
            key = `dim:${parsed.dimension}`;
        } else if (parsed.unit) {
            // Merge naive plurals of unknown units ("bunch" + "bunches").
            key = `raw:${parsed.unit.replace(/e?s$/, '')}`;
        } else {
            key = 'count';
        }

        let group = groups.get(key);
        if (!group) {
            group = { targetUnit: parsed.unit, baseSum: 0, known: parsed.known };
            groups.set(key, group);
        }

        if (group.known && group.targetUnit && parsed.unit) {
            const converted = convert(parsed.value, parsed.unit, group.targetUnit);
            group.baseSum += converted ?? parsed.value;
        } else {
            group.baseSum += parsed.value;
        }
    }

    return Array.from(groups.values())
        .map(g => g.known || !g.targetUnit
            ? formatQuantity(g.baseSum, g.targetUnit)
            : `${formatValue(g.baseSum)} ${g.targetUnit}`)
        .join(' + ');
}

/**
 * Splits an item's text into a quantity and the remaining name.
 * Handles "2 cups flour", "1 1/2 cups flour", "flour 200g", "2 chicken breasts"
 * (the word "chicken" is not a unit, so the quantity is just "2").
 */
export function parseQuantityAndText(text: string): { quantity: string | null; text: string } {
    if (!text) return { quantity: null, text: '' };
    const trimmed = text.trim();

    const startRegex = new RegExp(`^(${VALUE_PATTERN})\\s*([a-zA-Z]+)?\\s+(.+)$`);
    const startMatch = trimmed.match(startRegex);
    if (startMatch) {
        const value = parseValueToken(startMatch[1]);
        if (value !== null) {
            const unitDef = normalizeUnit(startMatch[2]);
            if (unitDef) {
                return { quantity: formatQuantity(value, unitDef.unit), text: startMatch[3] };
            }
            // Unknown token after the number ("2 chicken breasts") — it belongs to the name.
            const rest = [startMatch[2], startMatch[3]].filter(Boolean).join(' ');
            return { quantity: formatValue(value), text: rest };
        }
    }

    const endRegex = new RegExp(`^(.+?)\\s+(${VALUE_PATTERN})\\s*([a-zA-Z]+)?$`);
    const endMatch = trimmed.match(endRegex);
    if (endMatch) {
        const value = parseValueToken(endMatch[2]);
        const unitDef = normalizeUnit(endMatch[3]);
        if (value !== null && (unitDef || !endMatch[3])) {
            // Bare 4-digit numbers at the end are more likely years/labels than quantities.
            if (!unitDef && /^\d{4}$/.test(endMatch[2].trim())) {
                return { quantity: null, text: trimmed };
            }
            return {
                quantity: unitDef ? formatQuantity(value, unitDef.unit) : formatValue(value),
                text: endMatch[1],
            };
        }
    }

    return { quantity: null, text: trimmed };
}
