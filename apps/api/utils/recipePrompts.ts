// Prompt fragments shared by every recipe importer (URL, video transcript,
// photo). Kept in one place because these encode the contract with the shared
// quantity engine — three copies of "how to write a quantity" is exactly the
// kind of drift that produced the client/server split in the first place.

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

export const tagVocabulary = `
Add relevant tags in the "tags" array, drawn from this list where applicable:
'vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'nut-free', 'pescatarian', 'quick & easy', 'healthy & light', 'family friendly', 'comfort food', 'budget-friendly', 'adventurous', 'italian', 'mexican', 'american', 'mediterranean', 'indian', 'thai', 'japanese', 'chinese' (or another cuisine if none of these fit).
`;

export const recipeJsonShape = `
You MUST return a single raw JSON object matching this exact structure, with no
markdown, code fences, or any text outside the JSON:
{
  "name": "Recipe Name",
  "description": "A short, engaging description of the dish. Paraphrase or write your own to avoid reproducing copyrighted text.",
  "ingredients": [ { "name": "Ingredient Name", "quantity": "e.g. '1.5 cup' or '200 g' or '2-3 clove'" } ],
  "instructions": [ "Step 1...", "Step 2..." ],
  "tags": [ "Tag 1", "Tag 2" ],
  "photoURL": "the photo URL of the recipe, if available, else null"
}
Separate preparation methods from ingredient names. "1 cup butter, melted" gives
the ingredient name "butter" and adds an instruction step such as "Melt the butter."
`;

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

${recipeJsonShape}
${tagVocabulary}
${quantityFormatRules}
Set "photoURL" to null — a photo of a page is not a photo of the finished dish.
If the image does not contain a culinary recipe, return {"error": "RECIPE_NOT_FOUND"}.
`;
