// Server-side quantity normalization (backend handoff §3.4).
// Canonical units shared with the client quantity engine:
// g, kg, oz, lb, ml, l, tsp, tbsp, cup — or a bare number for countable items.

const UNICODE_FRACTIONS: Record<string, number> = {
  '½': 1 / 2,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '¼': 1 / 4,
  '¾': 3 / 4,
  '⅕': 1 / 5,
  '⅖': 2 / 5,
  '⅗': 3 / 5,
  '⅘': 4 / 5,
  '⅙': 1 / 6,
  '⅚': 5 / 6,
  '⅛': 1 / 8,
  '⅜': 3 / 8,
  '⅝': 5 / 8,
  '⅞': 7 / 8,
}

const UNIT_ALIASES: Record<string, string> = {
  g: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kilogram: 'kg', kilograms: 'kg',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  tsp: 'tsp', tsps: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup', c: 'cup',
}

const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('')

// "1 1/2", "1/2", "1.5", "1½", "½" — optionally followed by a single unit word.
const QUANTITY_RE = new RegExp(
  `^(\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+\\s*/\\s*\\d+|\\d+(?:\\.\\d+)?|\\d*\\s*[${FRACTION_CHARS}])\\s*([a-zA-Z]+\\.?)?$`
)

function parseAmount(raw: string): number | null {
  const text = raw.trim()

  const unicode = text.match(new RegExp(`^(\\d*)\\s*([${FRACTION_CHARS}])$`))
  if (unicode) {
    const whole = unicode[1] ? parseInt(unicode[1], 10) : 0
    return whole + (UNICODE_FRACTIONS[unicode[2]!] ?? 0)
  }

  const mixed = text.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/)
  if (mixed) {
    const den = parseInt(mixed[3]!, 10)
    if (!den) return null
    return parseInt(mixed[1]!, 10) + parseInt(mixed[2]!, 10) / den
  }

  const frac = text.match(/^(\d+)\s*\/\s*(\d+)$/)
  if (frac) {
    const den = parseInt(frac[2]!, 10)
    if (!den) return null
    return parseInt(frac[1]!, 10) / den
  }

  const num = Number(text)
  return Number.isFinite(num) ? num : null
}

function formatAmount(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/**
 * Normalizes a freeform quantity string to the canonical "<decimal> <unit>"
 * form when possible: "1 ½ cups" → "1.5 cup", "200g" → "200 g", "1/2 c" →
 * "0.5 cup". Strings that don't parse ("to taste", "2-3", "1 large") pass
 * through unchanged — the client treats those as freeform.
 */
export function normalizeQuantity(quantity: unknown): string {
  if (typeof quantity !== 'string') return ''
  const trimmed = quantity.trim()
  if (!trimmed) return ''

  const match = trimmed.match(QUANTITY_RE)
  if (!match) return trimmed

  const amount = parseAmount(match[1]!)
  if (amount === null) return trimmed

  const unitToken = match[2]?.replace(/\.$/, '').toLowerCase()
  if (!unitToken) return formatAmount(amount)

  const unit = UNIT_ALIASES[unitToken]
  if (!unit) return trimmed // unknown unit ("bunches") — leave freeform

  return `${formatAmount(amount)} ${unit}`
}

export function normalizeIngredients<T extends { quantity?: unknown }>(
  ingredients: T[] | undefined | null
): T[] {
  if (!Array.isArray(ingredients)) return []
  return ingredients.map((ing) => ({ ...ing, quantity: normalizeQuantity(ing?.quantity) }))
}
