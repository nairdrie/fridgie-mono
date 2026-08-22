// Durations mentioned in a recipe step, so the cooking view can offer a timer
// for them instead of making someone leave the app to set one.
//
// WHY THIS IS CONSERVATIVE
//
// A recipe step is prose, and prose is full of numbers that are not durations:
// oven temperatures, tin sizes, quantities, page references. A false positive
// here is a timer chip on "cut into 2 inch pieces", which is noise at exactly
// the moment the user has their hands full. So a number only becomes a duration
// when a time unit follows it directly — no inference, no "probably minutes".
//
// A RANGE TAKES ITS LOW END
//
// "Bake for 20-25 minutes" sets 20, because the number a cook wants is when to
// first go and look. Timing out early and finding it needs another five minutes
// is the working case; timing out late is a burnt dinner.
//
// Lives here rather than in the mobile app for the same reason mergeList.ts
// does: it is pure string logic that deserves tests, and "how long does this
// recipe take" is a question the server will eventually want to answer from the
// same rules.

export interface StepTimer {
  /** Total seconds to count down. */
  seconds: number;
  /** How the step said it — "20 minutes", "1 hour". Shown on the chip. */
  label: string;
}

const UNIT_SECONDS: [RegExp, number][] = [
  [/^(?:h|hr|hrs|hour|hours)$/i, 3600],
  [/^(?:m|min|mins|minute|minutes)$/i, 60],
  [/^(?:s|sec|secs|second|seconds)$/i, 1],
];

/**
 * Under this and a timer is theatre — nobody sets a countdown for ten seconds,
 * and "season for 5 seconds" is a misparse anyway.
 */
const MIN_SECONDS = 30;

/** Over this the number is not a kitchen timer: an overnight prove, a marinade. */
const MAX_SECONDS = 8 * 3600;

/**
 * `2`, `2.5`, `1 1/2` and `½` all appear in real steps. Written to require a
 * digit or a fraction glyph so bare words ("a few minutes") never match — those
 * are genuinely unmeasured and a timer would be inventing a number.
 */
const AMOUNT = String.raw`\d+(?:\.\d+)?(?:\s*\d\/\d)?|\d\/\d|[¼½¾⅓⅔]`;
const RANGE_SEP = String.raw`\s*(?:-|–|—|to|or)\s*`;
const UNIT = String.raw`h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds`;

const DURATION_RE = new RegExp(
  String.raw`(${AMOUNT})(?:${RANGE_SEP}(?:${AMOUNT}))?\s*(${UNIT})\b`,
  'gi',
);

const FRACTIONS: Record<string, number> = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };

function amountToNumber(raw: string): number | null {
  const text = raw.trim();
  if (FRACTIONS[text] !== undefined) return FRACTIONS[text];

  // "1 1/2"
  const mixed = text.match(/^(\d+)\s*(\d)\/(\d)$/);
  if (mixed) return parseInt(mixed[1]!, 10) + parseInt(mixed[2]!, 10) / parseInt(mixed[3]!, 10);

  const simple = text.match(/^(\d)\/(\d)$/);
  if (simple) return parseInt(simple[1]!, 10) / parseInt(simple[2]!, 10);

  const value = parseFloat(text);
  return Number.isFinite(value) ? value : null;
}

function unitSeconds(unit: string): number | null {
  for (const [pattern, seconds] of UNIT_SECONDS) {
    if (pattern.test(unit)) return seconds;
  }
  return null;
}

/** Human wording for a duration: "20 min", "1 hr 30 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

/** Counting display for a running timer: "4:07", "1:02:30". */
export function formatCountdown(seconds: number): string {
  const clamped = Math.max(0, Math.round(seconds));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Every timer a step offers, in the order they are mentioned and deduplicated
 * by length — "simmer 20 minutes, stirring every 20 minutes" is one chip.
 */
export function findStepTimers(step: string): StepTimer[] {
  if (typeof step !== 'string' || !step) return [];

  const found: StepTimer[] = [];
  const seen = new Set<number>();

  // A fresh lastIndex per call: the regex is module-level and /g is stateful.
  DURATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DURATION_RE.exec(step)) !== null) {
    const amount = amountToNumber(match[1] ?? '');
    const perUnit = unitSeconds(match[2] ?? '');
    if (amount === null || perUnit === null) continue;

    const seconds = Math.round(amount * perUnit);
    if (seconds < MIN_SECONDS || seconds > MAX_SECONDS) continue;
    if (seen.has(seconds)) continue;

    seen.add(seconds);
    found.push({ seconds, label: formatDuration(seconds) });
  }

  return found;
}
