import { Hono } from 'hono';
import { auth } from '@/middleware/auth';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { normalizeIngredients } from '@/utils/quantity';
import { completeJson, models } from '@/utils/claude';
// Shared with the photo importer so the quantity contract has one definition.
// The old inline copy told the model to collapse ranges ("2-3" -> "2"), which
// is now wrong: the quantity engine keeps both ends so totals don't under-buy.
import {
  importedRecipeSchema,
  quantityFormatRules,
  recipeWritingRules,
  tagVocabulary,
} from '@/utils/recipePrompts';

const route = new Hono();

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

const transcriptParsingSystemPrompt = `
You are an expert recipe parsing assistant. Analyze the transcript and description from a cooking video and extract the recipe.
The transcript is unstructured speech — infer the ingredients, quantities, and instructions from what is said.
A video has no still photo, so always set "photoURL" to null.
${recipeWritingRules}
${tagVocabulary}
${quantityFormatRules}
If the transcript and description do not contain a culinary recipe, set "found" to false and "recipe" to null.
`;


const isTikTokUrl = (url: string): boolean => {
  try {
    const { hostname } = new URL(url);
    return hostname.includes('tiktok.com');
  } catch (error) {
    return false;
  }
};

// ✅ 1. New helper function to generate a random IPv4 address
const generateRandomIp = (): string => {
  const octet = () => Math.floor(Math.random() * 256);
  return `${octet()}.${octet()}.${octet()}.${octet()}`;
};

route.use('*', auth);

route.post('/', async (c) => {
  const { url } = await c.req.json();
  if (!url) {
    return c.json({ error: 'URL is required' }, 400);
  }

  try {
    let systemPrompt: string;
    let userInput: string;

    if (isTikTokUrl(url)) {
      // --- TIKTOK LOGIC (USING EXTERNAL API) ---

      // ✅ 2. Generate a random IP and construct the API URL dynamically
      const randomIp = generateRandomIp();
      const apiUrl = `https://scriptadmin.tokbackup.com/v1/tiktok/fetchMultipleTikTokData?get_transcript=true&ip=${randomIp}`;


      const response = await axios.post(apiUrl, {
        videoUrls: [url],
      });

      // Safely extract the description and subtitles from the response
      const description = response.data?.data?.[0]?.data.desc || '';
      const subtitles = response.data?.data?.[0]?.subtitles || '';

      // Combine both for better context, as the description might contain ingredients
      const combinedText = `Video Description: ${description}\n\nTranscript:\n${subtitles}`.trim();
      if (!combinedText) {
        throw new Error('Could not retrieve transcript or description from API.');
      }

      systemPrompt = transcriptParsingSystemPrompt;
      userInput = `Here is the transcript and description from the cooking video:\n\n${combinedText}`;
    } else {
      // --- EXISTING WEBSITE SCRAPING LOGIC ---
      console.log(`Scraping website URL: ${url}`);
      const { data: html } = await axios.get(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        },
      });

      const $ = cheerio.load(html);
      const mainContentHtml =
        $('main').html() ||
        $('[role="main"]').html() ||
        $('article').html() ||
        $('#main-content').html() ||
        $('.recipe').html() ||
        $('body').html();

      if (!mainContentHtml || mainContentHtml.length < 100) {
        throw new Error('Could not extract sufficient HTML from the page.');
      }

      systemPrompt = htmlParsingSystemPrompt;
      userInput = `Here is the HTML from the recipe page:\n\n${mainContentHtml}`;
    }

    // --- COMMON AI LOGIC ---
    const { found, recipe } = await completeJson<{ found: boolean; recipe: any }>({
      model: models.recipeImport,
      system: systemPrompt,
      user: userInput,
      schema: importedRecipeSchema,
      effort: 'low',
    });

    if (!found || !recipe) {
      return c.json({ error: 'RECIPE_NOT_FOUND' }, 422);
    }

    // Belt-and-braces: canonicalize whatever quantity strings the model produced
    recipe.ingredients = normalizeIngredients(recipe.ingredients);
    return c.json(recipe);
  } catch (error) {
    console.error('Recipe import failed:', error);
    return c.json({ error: 'Failed to import and parse the recipe.' }, 500);
  }
});

export default route;