import { Hono } from 'hono';
import OpenAI from 'openai';
import { auth } from '@/middleware/auth';
import axios from 'axios';
import * as cheerio from 'cheerio';

const route = new Hono();
const openai = new OpenAI({ apiKey: Bun.env.OPENAI_API_KEY });

// ✅ 1. Updated prompt to tell the AI it's receiving HTML.
const parsingSystemPrompt = `
You are an expert recipe parsing assistant. Your task is to analyze the provided HTML content from a recipe webpage and extract the recipe details.
Pay attention to HTML tags like <h1>, <h2> for the name, <ul> and <li> for ingredients, and <ol> and <li> for instructions to identify the correct content.

You MUST return a single raw JSON object matching this exact structure. Do not include any other text, markdown, or code fences.
{
  "name": "Recipe Name",
  "description": "A short, engaging description of the dish.",
  "ingredients": [
    { "name": "Ingredient Name", "quantity": "e.g., 1 cup or 200g" }
  ],
  "instructions": [
    "Step 1...",
    "Step 2..."
  ]
}
`;

route.use('*', auth);

route.post('/', async (c) => {
  const { url } = await c.req.json();
  if (!url) {
    return c.json({ error: 'URL is required' }, 400);
  }

  try {
    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    });
    const $ = cheerio.load(html);

    // ✅ 2. Get the HTML content of the main section, not just the text.
    // This gives the AI structural context.
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

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: parsingSystemPrompt },
        // ✅ 3. Send the raw HTML content to the AI.
        { role: 'user', content: `Here is the HTML from the recipe page:\n\n${mainContentHtml}` },
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

