/**
 * Limits shared by the picker and API. Photos are sent directly to the
 * authenticated vision endpoint and are never uploaded to persistent storage.
 * Keeping the values here prevents a client/server mismatch that would make a
 * photo look accepted on-device only to be rejected after a long upload.
 */
export const MAX_LEFTOVERS_PHOTOS = 6;
export const MAX_LEFTOVERS_PHOTO_BYTES = 2 * 1024 * 1024;
export const MAX_LEFTOVERS_UPLOAD_BYTES = 6 * 1024 * 1024;
export const MAX_LEFTOVERS_INGREDIENTS = 80;
export const MAX_LEFTOVERS_INGREDIENT_LENGTH = 100;

/** Exact decoded size for a padded or unpadded base64 payload. */
export function base64ByteLength(value: string): number {
  const compact = value.replace(/\s/g, '');
  if (!compact) return 0;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

/**
 * User/model ingredient text crosses a trust boundary before reaching a
 * prompt. Bound it, remove blank values and de-duplicate without changing the
 * first spelling the person reviewed.
 */
export function normalizeLeftoversIngredients(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();

  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const ingredient = candidate.replace(/\s+/g, ' ').trim().slice(0, MAX_LEFTOVERS_INGREDIENT_LENGTH);
    const key = ingredient.toLocaleLowerCase();
    if (!ingredient || seen.has(key)) continue;
    seen.add(key);
    result.push(ingredient);
    if (result.length === MAX_LEFTOVERS_INGREDIENTS) break;
  }

  return result;
}
