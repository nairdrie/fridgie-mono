import { Hono } from 'hono';
import OpenAI from 'openai';
import { auth } from '@/middleware/auth';
import axios from 'axios';
import * as cheerio from 'cheerio';

const route = new Hono();

const apiKey = process.env.OPENAI_API_KEY || Bun.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey });

// --- Your existing prompts remain the same ---

const htmlParsingSystemPrompt = `
You are an expert recipe parsing assistant. Your task is to analyze the provided HTML content from a recipe webpage and extract the recipe details.
Pay attention to HTML tags like <h1>, <h2> for the name, <ul> and <li> for ingredients, and <ol> and <li> for instructions to identify the correct content.
You MUST return a single raw JSON object matching this exact structure. Do not include any other text, markdown, or code fences.
{
  "name": "Recipe Name",
  "description": "A short, engaging description of the dish. Paraphrase or make up your own to avoid copyright infringement.",
  "ingredients": [ { "name": "Ingredient Name", "quantity": "e.g., 1 cup or 200g" } ],
  "instructions": [ "Step 1...", "Step 2..." ],
  "tags": [ "Tag 1", "Tag 2" ],
  "photoURL": "the photo URL of the recipe, if available"
}
Add some relevant tags to the recipe in the "tags" array. Use the following tags and add them as applicable to the recipe:
'vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'nut-free', 'pescatarian', 'quick & easy', 'healthy & light', 'family friendly', 'comfort food', 'budget-friendly', 'adventurous', 'italian', 'mexican', 'american', 'mediterranean', 'indian', 'thai', 'japanese', 'chinese', (or other cuisine type if it doesn't fit in one of these)
DO NOT include markdown, code fences, or any text outside of the JSON object.
Separate preparation methods from ingredient names. For example, if you find "1 cup butter, melted", the ingredient name should be just "butter", and you must create a new first step in the instructions array, eg: "Melt the butter."
If an ingredient's quantity is listed with multiple units (e.g., '200g / 7 oz'), you must only use the first value and unit listed. The output for the example should be '200g'.
`;

const transcriptParsingSystemPrompt = `
You are an expert recipe parsing assistant. Your task is to analyze the provided transcript from a cooking video and extract the recipe details.
The transcript will be unstructured text. You must infer the ingredients, quantities, and instructions from the spoken words.
You MUST return a single raw JSON object matching this exact structure. Do not include any other text, markdown, or code fences.
{
  "name": "Recipe Name (e.g., 'Spicy Chicken Stir-Fry')",
  "description": "A short, engaging description of the dish. Create a suitable description based on the ingredients and instructions.",
  "ingredients": [ { "name": "Ingredient Name", "quantity": "e.g., '1 cup' or '200g'" } ],
  "instructions": [ "Step 1...", "Step 2..." ],
  "tags": [ "Tag 1", "Tag 2" ],
  "photoURL": null
}
Add some relevant tags to the recipe in the "tags" array. Use the following tags and add them as applicable to the recipe:
'vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'nut-free', 'pescatarian', 'quick & easy', 'healthy & light', 'family friendly', 'comfort food', 'budget-friendly', 'adventurous', 'italian', 'mexican', 'american', 'mediterranean', 'indian', 'thai', 'japanese', 'chinese', (or other cuisine type if it doesn't fit in one of these)
DO NOT include markdown, code fences, or any text outside of the JSON object. The video won't have a photo, so always set photoURL to null.
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
      const videoData = response.data?.data?.[0];
      const description = videoData?.desc || '';
      const subtitles = videoData?.subtitles || '';

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
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
      ],
      response_format: { type: 'json_object' },
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('AI returned empty content.');
    }

    const recipe = JSON.parse(content);
    return c.json(recipe);
  } catch (error) {
    console.error('Recipe import failed:', error);
    return c.json({ error: 'Failed to import and parse the recipe.' }, 500);
  }
});

export default route;