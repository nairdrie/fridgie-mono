import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { requireAccount } from '@/middleware/requireAccount';
import { normalizeIngredients } from '@/utils/quantity';
import { completeJson, models } from '@/utils/claude';
import { importedRecipeSchema, photoParsingSystemPrompt } from '@/utils/recipePrompts';

// POST /api/recipe/import/photo
// Body: { image: "data:image/jpeg;base64,..." }
//
// Reads a photograph of a printed or handwritten recipe and returns the same
// Recipe shape as the URL importer, so the client can hand the result to the
// identical review-and-edit screen.
//
// The image arrives as a base64 data URL rather than a Storage link on purpose:
// it is transient input, not something the user is saving, so uploading it would
// leave orphaned objects behind and expose a publicly-readable URL for what may
// be a photo of someone's private notebook.

const route = new Hono();

/** Generous enough for a high-quality page photo, small enough to reject abuse. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DATA_URL_RE = /^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,([A-Za-z0-9+/=]+)$/;

/** The image block takes the raw base64 and its media type, not a data URL. */
const MEDIA_TYPES = {
  jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
} as const;

route.use('*', auth, requireAccount);

route.post('/', async (c) => {
  let body: { image?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const image = body?.image;
  if (typeof image !== 'string' || !image) {
    return c.json({ error: 'image is required (base64 data URL)' }, 400);
  }

  const match = image.match(DATA_URL_RE);
  if (!match) {
    return c.json({ error: 'image must be a base64 data URL of a jpeg, png or webp' }, 400);
  }

  // Claude reads jpeg, png, gif and webp. HEIC has to be rejected here with a
  // usable message rather than sent on to fail as an opaque 400 upstream.
  const format = match[1]!.toLowerCase();
  const mediaType = MEDIA_TYPES[format as keyof typeof MEDIA_TYPES];
  if (!mediaType) {
    return c.json({ error: 'HEIC photos are not supported. Please retake or export as JPEG.' }, 415);
  }

  // base64 is ~4/3 of the byte length; check before handing it to the model.
  const approxBytes = Math.floor((match[2]!.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    return c.json({ error: 'Image is too large. Please retake it at a lower quality.' }, 413);
  }

  try {
    // Reading a shadowed, angled page of someone's handwriting is a perception
    // problem, not an extraction one — worth more thinking than the URL importer.
    const { found, recipe } = await completeJson<{ found: boolean; recipe: any }>({
      model: models.recipePhoto,
      system: photoParsingSystemPrompt,
      user: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: match[2]! } },
        { type: 'text', text: 'Extract the recipe from this photo.' },
      ],
      schema: importedRecipeSchema,
      effort: 'medium',
    });

    if (!found || !recipe) {
      return c.json({ error: 'RECIPE_NOT_FOUND' }, 422);
    }

    // A photo of a page is not a photo of the dish; never let one through.
    recipe.photoURL = null;
    recipe.ingredients = normalizeIngredients(recipe.ingredients);
    return c.json(recipe);
  } catch (error) {
    console.error('Recipe photo import failed:', error);
    return c.json({ error: 'Failed to read the recipe from that photo.' }, 500);
  }
});

export default route;
