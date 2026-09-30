export const boundedPromptStrings = (value: unknown, maxItems: number, maxLength: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.replace(/\s+/g, ' ').trim().slice(0, maxLength))
        .filter(Boolean)
        .slice(0, maxItems)
    : [];

/**
 * Safety constraints deliberately precede inventory. "Use what I have" is a
 * preference, never permission to violate a dietary need or dislike.
 */
export function mealConstraintLines(input: {
  dietaryNeeds: string[];
  disliked?: string;
  leftoversIngredients: string[];
}): string[] {
  const lines: string[] = [];
  if (input.dietaryNeeds.length) {
    lines.push(`Dietary needs (hard constraints): ${input.dietaryNeeds.join(', ')}.`);
  }
  if (input.disliked) lines.push(`Must NOT contain: ${input.disliked}.`);
  if (input.leftoversIngredients.length) {
    lines.push(
      `Confirmed ingredients available to use (prioritize these, but ordinary pantry staples are allowed): ${input.leftoversIngredients.join(', ')}.`,
    );
  }
  return lines;
}
