// Oven temperatures mentioned in a recipe step, so the recipe view can offer to
// read them in the other scale instead of making someone reach for a converter.
// The sibling of cookTimers.ts: same idea, same conservatism, different noun.
//
// WHY THIS IS CONSERVATIVE
//
// A recipe step is prose, and prose is full of numbers that are not
// temperatures: tin sizes, quantities, page references, times. So a number
// only becomes a temperature when the text says so — a degree sign, the word
// "degrees", or an F/C scale token right after it. A bare "cut into 2 inch
// pieces" or "add 2 cups" never becomes a tappable temperature.
//
// WHY A SCALE IS REQUIRED (AND WHEN ONE IS INFERRED)
//
// You cannot convert what you cannot place: "180" could be a hot Fahrenheit or a
// moderate Celsius oven, and guessing wrong turns a helpful button into a
// confidently wrong one. So an explicit scale (F / C / Fahrenheit / Celsius /
// centigrade / ℉ / ℃) is honoured as written. When only a degree marker is
// present — "preheat to 400°", "bake at 425 degrees" — the scale is inferred as
// Fahrenheit ONLY once the number is high enough that Celsius is implausible for
// a home oven (see INFER_MIN). Below that the reading is genuinely ambiguous and
// is left as plain text rather than mis-converted.
//
// Lives here rather than in the mobile app for the same reason cookTimers.ts
// does: it is pure string logic with real edge cases that deserve tests, and the
// server may one day want to read a recipe's temperatures from the same rules.

export type TempScale = 'F' | 'C';

export interface Temperature {
  /** The exact text this came from — "400°F", "180 C", "350 degrees". */
  raw: string;
  /** The numeric reading, in `unit`. */
  value: number;
  /** The scale it is expressed in — written in the text, or inferred. */
  unit: TempScale;
  /** True when the scale was not written and was inferred from the value. */
  inferred: boolean;
}

/**
 * One run of a step, in order. Plain prose comes back as `{ text }`; a
 * convertible temperature as `{ text, temp }` where `text` is the verbatim
 * match. Concatenating every `text` reproduces the original step exactly, which
 * is what lets the UI rebuild the sentence with only the temperatures made
 * tappable.
 */
export interface TempSegment {
  text: string;
  temp?: Temperature;
}

/** 2–3 digits, optionally a decimal. Oven temps are never 1 or 4 digits. */
const NUM = String.raw`\d{2,3}(?:\.\d+)?`;
/** Scale tokens, longest first so "celsius" wins over a bare "c". */
const SCALE = String.raw`fahrenheit|celsius|centigrade|f|c`;
/** A degree marker: the sign, the precomposed glyphs, or the spelled word. */
const DEG = String.raw`°|℉|℃|degrees?\.?|degs\.?|deg\.?`;

// A number, then EITHER a degree marker with an optional scale, OR a bare scale
// token — one of the two must be present, so a lone number never matches. The
// trailing `(?![a-z])` stops a scale letter from eating into a word: the "c" in
// "100cc" or "350 cloves", the "F" in "400 Fresh".
const TEMP_RE = new RegExp(
  String.raw`\b(${NUM})\s*(?:(${DEG})\s*(${SCALE})?|(${SCALE}))(?![a-z])`,
  'gi',
);

/**
 * Below this, a bare degree marker with no scale is too ambiguous to place — 250
 * is a low Fahrenheit oven or a fierce Celsius one. At or above it, Celsius is
 * off the end of any home oven, so Fahrenheit is the only sane reading.
 */
const INFER_MIN = 300;

/** Plausible cooking ranges, by scale. Outside these it is not a temperature. */
const RANGE: Record<TempScale, [number, number]> = {
  F: [90, 550],
  C: [30, 300],
};

function scaleUnit(token: string): TempScale {
  const s = token.toLowerCase();
  // celsius / centigrade / c → C; fahrenheit / f → F.
  return s === 'c' || s.startsWith('cel') || s.startsWith('cen') ? 'C' : 'F';
}

function inRange(value: number, unit: TempScale): boolean {
  const [lo, hi] = RANGE[unit];
  return value >= lo && value <= hi;
}

/**
 * Turn one regex match into a Temperature, or null when it is not a convertible
 * temperature after all (out of range, or a bare degree too low to place).
 */
function interpret(match: RegExpExecArray): Temperature | null {
  const value = parseFloat(match[1] ?? '');
  if (!Number.isFinite(value)) return null;

  const degree = match[2];                  // degree marker, or undefined
  const scaleToken = match[3] ?? match[4];   // scale after a marker, or a bare scale

  let unit: TempScale;
  let inferred = false;

  if (degree === '℉') {
    unit = 'F';
  } else if (degree === '℃') {
    unit = 'C';
  } else if (scaleToken) {
    unit = scaleUnit(scaleToken);
  } else {
    // A degree marker with no scale ("400°", "425 degrees"). Only Fahrenheit is
    // safe to assume, and only once Celsius is out of the question.
    if (value < INFER_MIN) return null;
    unit = 'F';
    inferred = true;
  }

  if (!inRange(value, unit)) return null;
  return { raw: match[0], value, unit, inferred };
}

/**
 * Every run of a step in order, temperatures marked. Prose with no temperature
 * comes back as a single `{ text }` segment, so this is safe to call on every
 * step. Junk input yields an empty list.
 */
export function splitStepTemperatures(step: string): TempSegment[] {
  if (typeof step !== 'string' || !step) return [];

  const segments: TempSegment[] = [];
  let last = 0;

  // A fresh lastIndex per call: the regex is module-level and /g is stateful.
  TEMP_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEMP_RE.exec(step)) !== null) {
    // Guard against a zero-width match wedging the loop (belt and braces — the
    // pattern always consumes at least two digits).
    if (match.index === TEMP_RE.lastIndex) TEMP_RE.lastIndex++;

    const temp = interpret(match);
    // A match that isn't really a temperature (out of range, unplaceable) is
    // left where it is: `last` doesn't move, so the characters fold back into
    // the surrounding prose segment.
    if (!temp) continue;

    if (match.index > last) segments.push({ text: step.slice(last, match.index) });
    segments.push({ text: match[0], temp });
    last = match.index + match[0].length;
  }

  if (last < step.length) segments.push({ text: step.slice(last) });
  return segments.length > 0 ? segments : [{ text: step }];
}

/** Just the temperatures a step mentions, in order. */
export function findStepTemperatures(step: string): Temperature[] {
  const found: Temperature[] = [];
  for (const segment of splitStepTemperatures(step)) {
    if (segment.temp) found.push(segment.temp);
  }
  return found;
}

/** Nearest 5 — oven-chart numbers, never a stray decimal off a conversion. */
function roundOven(value: number): number {
  return Math.round(value / 5) * 5;
}

/**
 * The same reading in the other scale. The converted value is rounded to the
 * nearest 5 so it reads like an oven dial (400°F → 205°C, 180°C → 355°F); the
 * original is always kept exact by whoever holds it, so toggling back is lossless.
 */
export function convertTemperature(temp: Temperature): Temperature {
  if (temp.unit === 'F') {
    return { ...temp, value: roundOven(((temp.value - 32) * 5) / 9), unit: 'C' };
  }
  return { ...temp, value: roundOven((temp.value * 9) / 5 + 32), unit: 'F' };
}

/** Display form: "400°F", "205°C". */
export function formatTemperature(temp: Temperature): string {
  return `${Math.round(temp.value)}°${temp.unit}`;
}
