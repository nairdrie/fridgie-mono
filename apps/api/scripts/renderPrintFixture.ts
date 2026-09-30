import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import type { CookbookPrintDraft, Recipe } from '@fridgie/shared/types';
import { createCookbookPrintSnapshot, layoutCookbook } from '@/utils/cookbookPrint';
import { renderCookbookPdfs } from '@/utils/cookbookPrintPdf';

const now = '2026-09-29T12:00:00.000Z';
const imageUrl = 'https://fixture.invalid/tomatoes.jpg';
const recipes: Recipe[] = Array.from({ length: 14 }, (_, index) => ({
  id: `recipe-${index + 1}`,
  name: index === 0 ? 'Roasted Tomato Supper' : `${['Garden', 'Sunday', 'Golden', 'Cozy'][index % 4]} Recipe ${index + 1}`,
  description: 'A warm, practical recipe for the table, with bright herbs and a little time to settle into itself.',
  photoURL: imageUrl,
  ingredients: [
    { quantity: '2 cups', name: 'ripe tomatoes' },
    { quantity: '1 tbsp', name: 'olive oil' },
    { quantity: '2 cloves', name: 'garlic, finely sliced' },
    { quantity: '1 handful', name: 'fresh herbs' },
  ],
  instructions: [
    'Heat the oven and arrange the tomatoes in a single layer with the olive oil and a generous pinch of salt.',
    'Roast until the edges deepen in colour, then add the garlic and return the tray to the oven for five minutes.',
    'Fold through the herbs, taste, and serve while warm.',
  ],
  servings: 4,
  category: index < 5 ? 'Mains' : index < 10 ? 'Sides' : 'Desserts',
  createdBy: 'fixture-user',
  visibility: 'private',
}));
recipes[13] = {
  ...recipes[13]!,
  name: 'A Favourite From Elsewhere',
  sourceUrl: 'https://example.com/original-recipe',
  sourceAuthor: 'The original cook',
};

const draft: CookbookPrintDraft = {
  id: 'fixture-draft',
  revision: 1,
  status: 'active',
  createdAt: now,
  updatedAt: now,
  title: 'Around Our Table',
  subtitle: 'Recipes for ordinary days and long Sundays',
  dedication: 'For everyone who wandered into the kitchen and stayed for dinner.',
  byline: 'The Fridgie Family',
  theme: 'photo-forward',
  sku: 'matte-softcover',
  coverRecipeId: recipes[0]!.id,
  coverCrop: { x: 0.5, y: 0.45, zoom: 1.1 },
  includeTableOfContents: true,
  includeIndex: true,
  recipes: recipes.map((recipe, position) => ({
    recipeId: recipe.id,
    included: true,
    position,
    section: recipe.category,
    photoPlacement: 'hero',
    rightsMode: recipe.sourceUrl ? 'source-only' : 'original-or-licensed',
    notes: recipe.sourceUrl ? 'Try this with the herbs we grow on the balcony.' : undefined,
  })),
};

const photo = await sharp({
  create: { width: 2600, height: 3600, channels: 3, background: '#D98268' },
}).composite([
  { input: Buffer.from('<svg width="2600" height="3600"><rect x="150" y="150" width="2300" height="3300" rx="220" fill="#F3C79C"/><circle cx="950" cy="1880" r="620" fill="#C95245"/><circle cx="1710" cy="1770" r="540" fill="#E56D55"/><path d="M820 1300 C980 820 1280 850 1380 1350" stroke="#39755C" stroke-width="120" fill="none"/><path d="M1520 1260 C1700 850 1970 900 2050 1400" stroke="#39755C" stroke-width="120" fill="none"/></svg>') },
]).jpeg({ quality: 95 }).toBuffer();

const snapshot = createCookbookPrintSnapshot({ id: 'fixture-snapshot', ownerUid: 'fixture-user', draft, recipes, now: new Date(now) });
const plan = layoutCookbook(snapshot);
const artifacts = await renderCookbookPdfs(snapshot, plan, { fetchImage: async () => photo });
const output = resolve(process.argv[2] || '../../output/pdf');
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(resolve(output, 'fridgie-cookbook-interior.pdf'), artifacts.interior),
  writeFile(resolve(output, 'fridgie-cookbook-cover.pdf'), artifacts.cover),
]);
console.log(JSON.stringify({ output, pageCount: artifacts.pageCount, issues: artifacts.issues, interiorSha256: artifacts.interiorSha256, coverSha256: artifacts.coverSha256 }, null, 2));
