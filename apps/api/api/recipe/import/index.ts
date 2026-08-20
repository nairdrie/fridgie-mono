import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import { requireAccount } from '@/middleware/requireAccount';
import axios from 'axios';
import { normalizeIngredients } from '@/utils/quantity';
import { completeJson, models, type JsonCallOptions } from '@/utils/claude';
import { extractMainContent, extractRecipeJsonLd, type SourceRecipe } from '@/utils/recipeExtract';
import { collectTikTokSource, isTikTokUrl, sampleVideoFrames } from '@/utils/tiktok';
// Shared with the photo importer so the quantity contract has one definition.
// The old inline copy told the model to collapse ranges ("2-3" -> "2"), which
// is now wrong: the quantity engine keeps both ends so totals don't under-buy.
import {
  importedRecipeSchema,
  quantityFormatRules,
  recipeSchema,
  recipeWritingRules,
  tagVocabulary,
} from '@/utils/recipePrompts';

const route = new Hono();

/**
 * Ceiling on page markup handed to the model, in characters (~34K tokens,
 * roughly $0.10 of Sonnet input). Generous for a real recipe page once scripts
 * and styles are stripped; the point is to bound the worst case, not the
 * typical one.
 */
const MAX_PAGE_CHARS = 120_000;

/**
 * The same ceiling for the JSON-LD path, two orders of magnitude lower because
 * the input is already the recipe rather than the page it sits on. A real one
 * runs 1-2KB; anything near this bound is a site publishing its whole catalogue
 * in one block.
 */
const MAX_SOURCE_CHARS = 20_000;

/** A page that hasn't answered by now is not going to rescue this request. */
const FETCH_TIMEOUT_MS = 15_000;

// Both prompts below are constant, so each one caches independently on its own
// prefix. Nothing per-request may be appended to them.

const htmlParsingSystemPrompt = `
You are an expert recipe parsing assistant. Analyze the provided HTML from a recipe webpage and extract the recipe.
Pay attention to tags like <h1>/<h2> for the name, <ul>/<li> for ingredients, and <ol>/<li> for instructions.
Set "photoURL" to the URL of a photo of the finished dish if the page has one, else null.
${recipeWritingRules}
${tagVocabulary}
${quantityFormatRules}
If the page does not contain a culinary recipe, set "found" to false and "recipe" to null.
`;

const videoParsingSystemPrompt = `
You are an expert recipe parsing assistant reading a cooking video from TikTok. You are given the video's caption, a transcript of its speech where one exists, and a series of still frames sampled from it in chronological order.

Weigh those three sources by how reliable each one is:
- ON-SCREEN TEXT IN THE FRAMES IS THE MOST RELIABLE SOURCE OF QUANTITIES. Cooking videos caption their ingredient amounts on screen ("2 tbsp gochujang") while the speech only says "add a bit of this". Read every frame for overlaid text and prefer what it says over what is spoken.
- The caption frequently contains the full written recipe. Treat it as authoritative where it is specific.
- The transcript is automatic speech recognition. It has no punctuation you can trust, it mishears ingredient names, and it may be absent entirely. Use it for the method and the order of steps rather than for numbers.

Where the sources disagree about an amount, prefer on-screen text, then the caption, then the speech.
Do not invent a quantity that appears in none of them — use an empty string instead, and let the cook fill it in.
Read the frames for the method too: a step that is shown but never mentioned is still a step.
Ignore the parts of a caption that are not the recipe — hashtags, follow-me pleas, and links.
A still photo of the finished dish is supplied separately, so always set "photoURL" to null.
${recipeWritingRules}
${tagVocabulary}
${quantityFormatRules}
If this is not a cooking video, set "found" to false and "recipe" to null.
`;

/**
 * The JSON-LD path. Extraction has already happened — the page told us its own
 * ingredients and steps — so this prompt asks for the three things the markup
 * genuinely cannot supply: the name/quantity split, a description in our voice,
 * and our closed tag vocabulary.
 *
 * Told explicitly not to invent, because a short structured input makes padding
 * tempting in a way a wall of HTML does not.
 */
const jsonLdParsingSystemPrompt = `
You are an expert recipe parsing assistant. The JSON below was published by the recipe's own website as schema.org/Recipe markup, so treat it as accurate — your job is to restructure it, not to second-guess it.

Work only from what the JSON contains:
- Use every ingredient line given, in the order given, and no others. Never add an ingredient the source does not list.
- Keep the given steps, in order. Do not invent steps beyond the preparation ones described below.
- If a field is missing from the JSON, leave the corresponding output empty rather than filling it in from general knowledge.

Split each ingredient line into a name and a quantity. The lines are freeform and usually carry a preparation as well: "1 1/2 cups Green cabbage, thinly sliced" becomes name "green cabbage", quantity "1.5 cup", and an instruction step for the slicing. Drop editorial asides that are neither quantity nor ingredient ("20-30% fat preferred", "tap hot, not boiling!").
Where a preparation is implied by an ingredient line but no step covers it, add that step in the right place in the sequence.
Use "sourceKeywords" only as candidates for the tag list — they are the site's own labels, not ours, and many will not map to our vocabulary.
${recipeWritingRules}
${tagVocabulary}
${quantityFormatRules}
`;

/**
 * A failure the caller can act on, as opposed to the blanket 500 this route
 * used to return for everything. The three cases really are different: a page
 * we couldn't load, a page with nothing on it, and a page with no recipe on it.
 */
type ImportStatus = 422 | 502;
class ImportError extends Error {
  constructor(readonly code: string, readonly status: ImportStatus, message: string) {
    super(message);
  }
}

/** Only the fields worth spending tokens on, and only when the page supplied them. */
function sourceForModel(source: SourceRecipe): string {
  const payload = {
    name: source.name ?? undefined,
    sourceDescription: source.description ?? undefined,
    ingredients: source.ingredients,
    instructions: source.instructions.length > 0 ? source.instructions : undefined,
    sourceKeywords: source.keywords.length > 0 ? source.keywords : undefined,
    recipeYield: source.recipeYield ?? undefined,
    totalTime: source.totalTime ?? undefined,
  };
  return JSON.stringify(payload, null, 2).slice(0, MAX_SOURCE_CHARS);
}

async function fetchPage(url: string): Promise<string> {
  try {
    const { data } = await axios.get<string>(url, {
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 5,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    return typeof data === 'string' ? data : String(data);
  } catch (error) {
    // Distinguishable from a parse failure: nothing here is the model's fault,
    // and retrying the same URL will not help until the site comes back.
    console.warn(`Recipe page fetch failed (${url}):`, error instanceof Error ? error.message : error);
    throw new ImportError('FETCH_FAILED', 502, 'Could not load that page.');
  }
}

route.use('*', auth, requireAccount);

route.post('/', async (c) => {
  const { url } = await c.req.json();
  if (!url) {
    return c.json({ error: 'URL is required' }, 400);
  }

  try {
    let systemPrompt: string;
    let userInput: JsonCallOptions['user'];
    // Set only on the paths where the source's own values for these beat
    // anything read back out of a model.
    let source: SourceRecipe | null = null;
    let tiktok: Awaited<ReturnType<typeof collectTikTokSource>> | null = null;

    if (isTikTokUrl(url)) {
      // --- TIKTOK: THE SITE'S OWN DATA, THEN THE VIDEO ITSELF ---
      tiktok = await collectTikTokSource(url);

      // Frames are the only place most recipe TikToks state their quantities,
      // so they are worth fetching even when the caption looks complete. This
      // degrades to [] rather than throwing if the video cannot be reached.
      const frames = await sampleVideoFrames(tiktok);

      const text = [
        tiktok.author ? `Creator: ${tiktok.author}` : null,
        tiktok.caption ? `Caption:\n${tiktok.caption}` : null,
        tiktok.transcript ? `Transcript (automatic speech recognition):\n${tiktok.transcript}` : null,
      ].filter(Boolean).join('\n\n');

      if (!text && frames.length === 0) {
        throw new ImportError(
          'VIDEO_UNAVAILABLE',
          422,
          'We could not read that video. It may be private, deleted, or region-locked.',
        );
      }

      console.log(
        `TikTok source: caption ${tiktok.caption.length} chars, transcript ` +
        `${tiktok.transcript.length} chars, ${frames.length} frames (${url})`,
      );

      systemPrompt = videoParsingSystemPrompt;
      userInput = [
        ...frames.map((data, i) => ([
          { type: 'text' as const, text: `Frame ${i + 1} of ${frames.length}:` },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data } },
        ])).flat(),
        { type: 'text' as const, text: text || 'This video has no caption or transcript; read the frames.' },
      ];
    } else {
      const html = await fetchPage(url);

      // --- SCHEMA.ORG JSON-LD, BEFORE ANYTHING IS STRIPPED ---
      // Read this off the raw html: JSON-LD lives in a <script>, and the markup
      // cleanup below deletes exactly the element that holds the answer.
      source = extractRecipeJsonLd(html);

      if (source) {
        console.log(
          `Recipe JSON-LD found: ${source.ingredients.length} ingredients, ` +
          `${source.instructions.length} steps (${url})`,
        );
        systemPrompt = jsonLdParsingSystemPrompt;
        userInput = `Here is the recipe as the site published it:\n\n${sourceForModel(source)}`;
      } else {
        // --- FALLBACK: READ THE PAGE MARKUP ---
        console.log(`No recipe JSON-LD, falling back to markup: ${url}`);
        const mainContentHtml = extractMainContent(html);
        if (!mainContentHtml) {
          throw new ImportError('NO_CONTENT', 422, 'That page had no readable content.');
        }

        // Hard ceiling on what reaches the model. There was only a MINIMUM length
        // check here, so a 400KB page went straight through at roughly 114K input
        // tokens — about $0.34 a call — and this endpoint is reachable by anyone
        // who can register an account, which is self-service.
        const trimmed = mainContentHtml.length > MAX_PAGE_CHARS
          ? mainContentHtml.slice(0, MAX_PAGE_CHARS)
          : mainContentHtml;
        if (trimmed.length < mainContentHtml.length) {
          console.warn(
            `Recipe page truncated: ${mainContentHtml.length} -> ${MAX_PAGE_CHARS} chars (${url})`,
          );
        }

        systemPrompt = htmlParsingSystemPrompt;
        userInput = `Here is the HTML from the recipe page:\n\n${trimmed}`;
      }
    }

    // --- COMMON AI LOGIC ---
    // Reading quantities off a video's on-screen text is a perception problem,
    // the same one the photo importer spends extra thinking on. The two text
    // paths are extraction, and low effort is the right call there.
    const call = tiktok
      ? { model: models.recipeVideo, effort: 'medium' as const }
      : { model: models.recipeImport, effort: 'low' as const };

    // On the JSON-LD path the page has already told us a recipe is there, so the
    // found/recipe wrapper has nothing left to decide and the narrower schema
    // saves the model a field it would only ever set one way.
    const parsed = source
      ? {
          found: true,
          recipe: await completeJson<any>({
            ...call,
            system: systemPrompt,
            user: userInput,
            schema: recipeSchema,
          }),
        }
      : await completeJson<{ found: boolean; recipe: any }>({
          ...call,
          system: systemPrompt,
          user: userInput,
          schema: importedRecipeSchema,
        });

    const { found, recipe } = parsed;
    if (!found || !recipe) {
      return c.json({ error: 'RECIPE_NOT_FOUND' }, 422);
    }

    if (tiktok?.photoURL) {
      // The cover image, which the model was told to leave null — it never sees
      // the URL, and a video has no other still of the finished dish.
      recipe.photoURL = tiktok.photoURL;
    }

    if (source) {
      // Both are verbatim strings the page already gave us. Round-tripping them
      // through the model buys nothing and can only corrupt them — a long signed
      // image URL is exactly the kind of token sequence that comes back subtly
      // different.
      recipe.photoURL = source.photoURL;
      if (source.name) recipe.name = source.name;
    }

    // Belt-and-braces: canonicalize whatever quantity strings the model produced
    recipe.ingredients = normalizeIngredients(recipe.ingredients);
    return c.json(recipe);
  } catch (error) {
    if (error instanceof ImportError) {
      console.warn(`Recipe import failed (${error.code}):`, error.message);
      return c.json({ error: error.code, message: error.message }, error.status);
    }
    console.error('Recipe import failed:', error);
    return c.json({ error: 'Failed to import and parse the recipe.' }, 500);
  }
});

export default route;
