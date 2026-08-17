import { Hono } from 'hono';
import OpenAI from 'openai';
import { auth } from '@/middleware/auth';
import { normalizeIngredients } from '@/utils/quantity';
import { photoParsingSystemPrompt } from '@/utils/recipePrompts';

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

const apiKey = process.env.OPENAI_API_KEY || Bun.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey });

/** Generous enough for a high-quality page photo, small enough to reject abuse. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DATA_URL_RE = /^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,([A-Za-z0-9+/=]+)$/;

route.use('*', auth);

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
    return c.json({ error: 'image must be a base64 data URL of a jpeg, png, webp or heic' }, 400);
  }

  // base64 is ~4/3 of the byte length; check before handing it to the model.
  const approxBytes = Math.floor((match[2]!.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    return c.json({ error: 'Image is too large. Please retake it at a lower quality.' }, 413);
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: photoParsingSystemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract the recipe from this photo.' },
            { type: 'image_url', image_url: { url: image, detail: 'high' } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI returned empty content.');

    const recipe = JSON.parse(content);
    if (recipe?.error === 'RECIPE_NOT_FOUND' || recipe?.name === 'RECIPE_NOT_FOUND') {
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
