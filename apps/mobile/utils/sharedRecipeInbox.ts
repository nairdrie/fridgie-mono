export interface SharedRecipeRequest {
  id: string;
  input: string;
  receivedAt: number;
}

export const SHARED_RECIPE_INBOX_KEY = 'fridgie.shared-recipe-inbox.v1';
export const MAX_SHARED_INPUT_LENGTH = 16_000;

/** Only our own small, versioned records are restored; native payloads stay transient. */
export function decodeSharedRecipeInbox(value: string | null): SharedRecipeRequest[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const ids = new Set<string>();
    return parsed.filter((entry): entry is SharedRecipeRequest => {
      if (!entry || typeof entry !== 'object') return false;
      const item = entry as Partial<SharedRecipeRequest>;
      if (typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id)
        || typeof item.input !== 'string' || !item.input.trim() || item.input.length > MAX_SHARED_INPUT_LENGTH
        || typeof item.receivedAt !== 'number' || !Number.isFinite(item.receivedAt)) return false;
      ids.add(item.id);
      return true;
    });
  } catch {
    return [];
  }
}

/** A repeated native notification must not open another copy of an active import. */
export function appendSharedRecipe(inbox: SharedRecipeRequest[], request: SharedRecipeRequest): SharedRecipeRequest[] {
  const input = request.input.trim();
  if (!input || input.length > MAX_SHARED_INPUT_LENGTH) throw new Error('Share one recipe link at a time.');
  if (inbox.some(item => item.input === input || item.id === request.id)) return inbox;
  return [...inbox, { ...request, input }];
}

export function removeSharedRecipe(inbox: SharedRecipeRequest[], id: string): SharedRecipeRequest[] {
  return inbox.filter(item => item.id !== id);
}
