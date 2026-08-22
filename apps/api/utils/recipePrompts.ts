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

/**
 * Must stay in step with packages/shared/servings.ts, which applies the same
 * object-yield rule when reading a page's own `recipeYield` — the two must
 * agree or the same page would import differently depending on whether it
 * published JSON-LD.
 */
export const servingsRules = `
Set "servings" to the number of PEOPLE the recipe feeds, as a whole number:
- Use the source's own statement where it makes one ("Serves 4", "4 servings", "Yield: 6 portions"). A range takes its LOW end: "serves 4-6" is 4.
- A yield that counts OBJECTS is not a serving count. "Makes 12 cookies", "1 loaf", "24 muffins", "2 dozen" — set "servings" to null for these unless the source separately says how many people it feeds.
- Never estimate a serving count from the ingredient amounts. null is the correct answer whenever the source does not say.
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
    servings: {
      anyOf: [{ type: 'integer' }, { type: 'null' }],
      description: 'People the recipe feeds. null when the source does not say.',
    },
  },
  required: ['name', 'description', 'ingredients', 'instructions', 'tags', 'servings'],
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
${servingsRules}
Set "photoURL" to null — a photo of a page is not a photo of the finished dish.
If the image does not contain a culinary recipe, set "found" to false and "recipe" to null.
`;

/**
 * Inventing a recipe from nothing but a title.
 *
 * The neighbouring prompts are all extraction — there is a source document and
 * the job is to read it faithfully. This one is the opposite, so the rules that
 * matter are the ones that keep an invention grounded: real quantities that add
 * up, steps in an order a cook can follow, and an ordinary supermarket.
 */
export const recipeGenerationSystemPrompt = `
You are an experienced recipe developer writing a complete, reliable recipe from
just the name of a dish.

Write the recipe you would actually hand someone, not a sketch of one:
- Write for 4 people unless the request names a number or the title says
  otherwise, and set "servings" to the number you actually wrote the quantities
  for. Never null on this path: you chose the amounts, so you know who they
  feed.
- Every ingredient needed to cook the dish, including oil, salt and pepper, in
  the order they are used. Quantities must be plausible and must balance —
  someone following this exactly should get a dish that works.
- Steps in cooking order, one action per step, with the cues a cook needs:
  temperatures, tin and pan sizes, times, and what "done" looks like.
- Assume an ordinary supermarket and an ordinary domestic kitchen. No
  specialist equipment or hard-to-source ingredients unless the dish is
  defined by them.

If the title names a real, established dish, write THAT dish faithfully — a
recognisable version of it, not a reinvention. If the title is loose ("something
with chicken", "a light summer dinner"), invent one specific dish that fits and
give it a proper name.

${recipeWritingRules}
${tagVocabulary}
${quantityFormatRules}
${servingsRules}
`;

/**
 * Same found/recipe shape as the importers, for the same reason — but here
 * "not found" means the title does not describe food at all ("Tuesday",
 * "asdf", "call the dentist"), which is worth saying rather than answering
 * with an invented dish nobody asked for.
 */
export const generatedRecipeSchema = {
  type: 'object',
  properties: {
    found: {
      type: 'boolean',
      description: 'False only if the title does not name or imply anything edible.',
    },
    recipe: {
      anyOf: [recipeSchema, { type: 'null' }],
    },
  },
  required: ['found', 'recipe'],
  additionalProperties: false,
} as const;
