// A NEW FILE, e.g., /api/recipe/import/index.ts

import { Hono } from 'hono';
import OpenAI from 'openai';
import { auth } from '@/middleware/auth';
import puppeteer from 'puppeteer'; // You'll need to add a web scraper library

const route = new Hono();
const openai = new OpenAI({ apiKey: Bun.env.OPENAI_API_KEY });

// This system prompt is crucial for parsing the scraped HTML
const parsingSystemPrompt = `
You are an expert recipe parsing assistant. Your task is to analyze the provided text content from a recipe webpage and extract the recipe details.

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
    // 1. Scrape the webpage content
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });
    // Extract text content; you might need a more sophisticated selector
    const pageText = await page.evaluate(() => document.body.innerText);
    await browser.close();

    if (!pageText || pageText.length < 100) {
        throw new Error("Could not extract sufficient text from the page.");
    }
    
    // 2. Call OpenAI to parse the text
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: parsingSystemPrompt },
        { role: 'user', content: `Here is the text from the recipe page:\n\n${pageText}` }
      ],
      response_format: { type: "json_object" },
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