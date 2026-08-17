// Prompt fragments and the JSON schema shared by everything that produces a
// recipe (URL import, video transcript, photo, meal suggestions). Kept in one
// place because these encode the contract with the shared quantity engine —
// three copies of "how to write a quantity" is exactly the kind of drift that
// produced the client/server split in the first place.
//
// Structure is now enforced by `recipeSchema` via structured outputs, so the
// prose below only has to carry what a schema can't: meaning, not shape.

/** Must stay in step with packages/shared/quantity.ts. */
export const quantityFormatRules = `
Quantity format rules (apply to every ingredient's "quantity" field):
- Express each quantity as "<number> <unit>", where the unit is one of: g, kg, oz, lb, ml, l, tsp, tbsp, cup — or a bare number for countable items (e.g. "2" for 2 eggs, with the ingredient name "eggs").
- Convert fractions (including unicode like ½) to decimals: "1 1/2 cups" -> "1.5 cup", "½ tsp" -> "0.5 tsp".
- PRESERVE ranges as a range: "2-3 cloves" -> "2-3 clove", "5 to 10 cloves" -> "5-10 clove". Do NOT collapse a range to one end of it.
- Never put a preparation into the quantity. "1 cup butter, melted" has quantity "1 cup", name "butter" — the melting becomes an instruction step.
- If an amount is listed with multiple units (e.g. "200g / 7 oz"), use only the first: "200 g".
- If the amount is not measurable, use "to taste" or an empty string.
`;

/** The closed vocabulary the app's tag filters understand. */
export const TAGS = [
  'vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'nut-free', 'pescatarian',
  'quick & easy', 'healthy & light', 'family friendly', 'comfort food',
  'budget-friendly', 'adventurous', 'italian', 'mexican', 'american',
  'mediterranean', 'indian', 'thai', 'japanese', 'chinese',
] as const;

export const tagVocabulary = `
Add relevant tags in the "tags" array, drawn from this list where applicable:
${TAGS.map((t) => `'${t}'`).join(', ')} (or another cuisine if none of these fit).
`;

/** Semantics the schema can't express. The shape itself is enforced, not asked for. */
export const recipeWritingRules = `
Write the description yourself — a short, engaging line about the dish. Paraphrase
rather than reproducing text from the source.
Separate preparation methods from ingredient names. "1 cup butter, melted" gives
the ingredient name "butter" and adds an instruction step such as "Melt the butter."
`;

const ingredientSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'The ingredient alone, with no preparation or quantity.' },
    quantity: { type: 'string', description: "e.g. '1.5 cup', '200 g', '2-3 clove', '2', 'to taste'." },
  },
  required: ['name', 'quantity'],
  additionalProperties: false,
} as const;

/** The recipe object every AI route produces. */
export const recipeSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    ingredients: { type: 'array', items: ingredientSchema },
    instructions: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'description', 'ingredients', 'instructions', 'tags'],
  additionalProperties: false,
} as const;

/**
 * An import either found a recipe or it didn't. Modelling that as a field beats
 * the old sentinel — the importers used to hunt for the literal string
 * "RECIPE_NOT_FOUND" in three different places on the parsed object because
 * the model could put it anywhere.
 */
export const importedRecipeSchema = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'False if the source contains no culinary recipe.' },
    recipe: {
      anyOf: [
        {
          ...recipeSchema,
          properties: {
            ...recipeSchema.properties,
            photoURL: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
              description: 'A photo of the finished dish if the source has one, else null.',
            },
          },
          required: [...recipeSchema.required, 'photoURL'],
        },
        { type: 'null' },
      ],
    },
  },
  required: ['found', 'recipe'],
  additionalProperties: false,
} as const;

/** Photographs of a printed or handwritten recipe — a page, card, or book. */
export const photoParsingSystemPrompt = `
You are an expert recipe parsing assistant reading a PHOTOGRAPH of a recipe —
a cookbook page, a recipe card, a handwritten note, or a screenshot.

Transcribe what is actually written. Read carefully:
- The photo may be angled, shadowed, curved, or partly cropped.
- Handwriting may be untidy; prefer the most plausible culinary reading.
- Ignore page furniture: headers, page numbers, captions, unrelated columns.
- If the image shows two pages, include only the recipe being photographed.
- Never invent an ingredient or a step you cannot actually read. If a quantity
  is illegible, use an empty string rather than guessing a number.

${recipeWritingRules}
${tagVocabulary}
${quantityFormatRules}
Set "photoURL" to null — a photo of a page is not a photo of the finished dish.
If the image does not contain a culinary recipe, set "found" to false and "recipe" to null.
`;
