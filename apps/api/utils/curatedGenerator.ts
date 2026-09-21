import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import OpenAI from 'openai';
import { RECIPE_CATEGORIES, type RecipeCategory } from '@fridgie/shared/recipeCategory';
import type { Ingredient } from '@fridgie/shared/types';
import type { JsonCallOptions } from './claude';

export interface CuratedCreatorDefinition {
  uid: string;
  slug: string;
  displayName: string;
  handle: string;
  bio: string;
  specialty: string;
  accent: 'sage' | 'peach' | 'lemon';
  photoURL?: string;
}

// Fictional editorial voices, never impersonated people. The publisher creates
// disabled Auth records without email/password; clients render palette initials.
export const CURATED_CREATORS: CuratedCreatorDefinition[] = [
  {
    uid: 'curated-maya-green', slug: 'maya-green', displayName: 'Maya Green', handle: 'maya.green',
    bio: 'A fictional Fridgie curator for colourful, plant-forward cooking. Recipes are AI-created and have not been kitchen-tested.',
    specialty: 'Plant-forward dinners, beans, seasonal vegetables and bright grain bowls; entirely vegetarian.', accent: 'sage',
  },
  {
    uid: 'curated-theo-skillet', slug: 'theo-skillet', displayName: 'Theo Skillet', handle: 'theo.skillet',
    bio: 'A fictional Fridgie curator for practical weeknight meals. Recipes are AI-created and have not been kitchen-tested.',
    specialty: 'Weeknight skillet, sheet-pan and one-pot dinners; accessible ingredients and at most 40 minutes total.', accent: 'peach',
  },
  {
    uid: 'curated-nora-sunday', slug: 'nora-sunday', displayName: 'Nora Sunday', handle: 'nora.sunday',
    bio: 'A fictional Fridgie curator for cosy food to share. Recipes are AI-created and have not been kitchen-tested.',
    specialty: 'Comforting soups, hearty stews, simple pasta and relaxed family meals; practical home cooking.', accent: 'lemon',
  },
  {
    uid: 'curated-olive-crumb', slug: 'olive-crumb', displayName: 'Olive Crumb', handle: 'olive.crumb',
    bio: 'A fictional Fridgie curator for easy bakes and slow breakfasts. Recipes are AI-created and have not been kitchen-tested.',
    specialty: 'Approachable baking, fruit desserts and generous breakfasts; clear weights, temperatures and timing.', accent: 'peach',
  },
];

export interface CuratedRecipeDraft {
  name: string;
  description: string;
  ingredients: Ingredient[];
  instructions: string[];
  tags: string[];
  category: RecipeCategory;
  servings: number;
  totalMinutes: number;
  photoURL?: string;
  imageKind?: 'ai-generated' | 'illustrative-stock';
  imageAttribution?: { label: string; url: string };
}

export interface CuratedRecipeRequest {
  creator: CuratedCreatorDefinition;
  recipeId: string;
  seed: string;
  recentTitles: string[];
}

type RecipeText = Omit<CuratedRecipeDraft, 'photoURL' | 'imageKind' | 'imageAttribution'>;
type RecipeImage = Pick<CuratedRecipeDraft, 'photoURL' | 'imageKind' | 'imageAttribution'>;
interface GeneratorDependencies {
  model: () => Promise<string>;
  completeJson: (options: JsonCallOptions) => Promise<unknown>;
  generateImage: (recipe: RecipeText, recipeId: string) => Promise<RecipeImage>;
  warn: (message: string) => void;
}

export const CURATED_GENERATION_REASONS = [
  'recipe', 'name', 'description', 'ingredients.count', 'ingredients.item',
  'ingredients.name', 'ingredients.quantity', 'ingredients.duplicate',
  'instructions.count', 'instructions.item', 'tags.count', 'tags.item',
  'tags.unique', 'servings', 'totalMinutes', 'category', 'duplicateTitle', 'request',
] as const;
export type CuratedGenerationReason = (typeof CURATED_GENERATION_REASONS)[number];

export class CuratedGenerationError extends Error {
  constructor(
    public readonly code: 'INVALID_RECIPE' | 'DUPLICATE_RECIPE' | 'INVALID_REQUEST',
    public readonly reason: CuratedGenerationReason = 'recipe',
  ) {
    super(code);
    this.name = 'CuratedGenerationError';
  }
}

const NUMERIC_LIMITS = {
  servings: { min: 2, max: 24 },
  totalMinutes: { min: 10, max: 180 },
} as const;
const integerValues = ({ min, max }: { min: number; max: number }) => Array.from({ length: max - min + 1 }, (_, index) => min + index);

const RECIPE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    name: { type: 'string' }, description: { type: 'string' },
    ingredients: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { name: { type: 'string' }, quantity: { type: 'string' } }, required: ['name', 'quantity'] } },
    instructions: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
    category: { type: 'string', enum: [...RECIPE_CATEGORIES] },
    // Anthropic supports numeric enums, but not minimum/maximum constraints.
    servings: { type: 'integer', enum: integerValues(NUMERIC_LIMITS.servings) },
    totalMinutes: { type: 'integer', enum: integerValues(NUMERIC_LIMITS.totalMinutes) },
  },
  required: ['name', 'description', 'ingredients', 'instructions', 'tags', 'category', 'servings', 'totalMinutes'],
};

const SYSTEM = `Write one original, complete recipe for Fridgie's clearly disclosed AI-curated collection.
The curator is a fictional editorial voice, not a real chef. Do not copy a named cook, brand or published recipe, invent attribution, claim authenticity, testing, personal experience, popularity, nutritional figures or medical benefits. Do not add links.
Match the curator's specialty. Choose familiar, obtainable ingredients and a distinctive, descriptive title. Avoid the supplied recent titles and near-identical dishes. Vary principal ingredient, technique and flavour profile using the supplied editorial seed.
Write for ${NUMERIC_LIMITS.servings.min} to ${NUMERIC_LIMITS.servings.max} servings as a whole number of people or portions. Choose a practical batch for the dish: dinners commonly serve 2 to 6, while bakes may serve 8, 12 or more. For baking, state the number of pieces and pieces per serving in the description or instructions; servings counts people, not the raw number of cookies, muffins or loaves. Use 5 to 18 ingredients, each with a concrete household quantity; use grams for baking. Include water, cooking oil and seasonings actually used. Write 4 to 10 clear sequential instructions that use all listed ingredients. Include preparation, pan size when important, oven temperature in C and F, active cooking times and useful doneness cues. Avoid raw meat, raw eggs, unsafe preservation and unverified allergen-free claims. Account for cooking, resting and preparation in totalMinutes (a whole number from ${NUMERIC_LIMITS.totalMinutes.min} to ${NUMERIC_LIMITS.totalMinutes.max}); choose a recipe whose complete preparation fits that time. Keep recipe prose concise: description 1-2 sentences, instructions at most 500 characters each. Choose 2-5 useful lowercase tags and one exact supplied category. Silently check quantities, sequence, timing and serving yield for coherence before returning the JSON.`;

const titleKey = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function text(value: unknown, min: number, max: number, reason: CuratedGenerationReason): string {
  if (typeof value !== 'string') throw new CuratedGenerationError('INVALID_RECIPE', reason);
  const result = value.trim();
  if (result.length < min || result.length > max || /https?:\/\/|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/i.test(result)) {
    throw new CuratedGenerationError('INVALID_RECIPE', reason);
  }
  return result;
}

function integer(value: unknown, { min, max }: { min: number; max: number }, reason: CuratedGenerationReason): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new CuratedGenerationError('INVALID_RECIPE', reason);
  }
  return value;
}

/** Project known fields only: the model cannot supply ownership or source IDs. */
export function validateCuratedRecipe(value: unknown, recentTitles: string[] = []): RecipeText {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CuratedGenerationError('INVALID_RECIPE');
  const item = value as Record<string, unknown>;
  const name = text(item.name, 5, 110, 'name');
  if (recentTitles.some(title => titleKey(title) === titleKey(name))) throw new CuratedGenerationError('DUPLICATE_RECIPE', 'duplicateTitle');
  if (!Array.isArray(item.ingredients) || item.ingredients.length < 5 || item.ingredients.length > 18) throw new CuratedGenerationError('INVALID_RECIPE', 'ingredients.count');
  if (!Array.isArray(item.instructions) || item.instructions.length < 4 || item.instructions.length > 10) throw new CuratedGenerationError('INVALID_RECIPE', 'instructions.count');
  if (!Array.isArray(item.tags) || item.tags.length < 2 || item.tags.length > 5) throw new CuratedGenerationError('INVALID_RECIPE', 'tags.count');
  const servings = integer(item.servings, NUMERIC_LIMITS.servings, 'servings');
  const totalMinutes = integer(item.totalMinutes, NUMERIC_LIMITS.totalMinutes, 'totalMinutes');
  if (!(RECIPE_CATEGORIES as readonly unknown[]).includes(item.category)) throw new CuratedGenerationError('INVALID_RECIPE', 'category');
  const ingredients = item.ingredients.map(ingredient => {
    if (!ingredient || typeof ingredient !== 'object' || Array.isArray(ingredient)) throw new CuratedGenerationError('INVALID_RECIPE', 'ingredients.item');
    return { name: text(ingredient.name, 2, 100, 'ingredients.name'), quantity: text(ingredient.quantity, 1, 65, 'ingredients.quantity') };
  });
  if (new Set(ingredients.map(ingredient => titleKey(ingredient.name))).size !== ingredients.length) throw new CuratedGenerationError('INVALID_RECIPE', 'ingredients.duplicate');
  const tags = [...new Set(item.tags.map(tag => text(tag, 2, 35, 'tags.item').toLowerCase()))];
  if (tags.length < 2) throw new CuratedGenerationError('INVALID_RECIPE', 'tags.unique');
  return {
    name, description: text(item.description, 20, 500, 'description'), ingredients,
    instructions: item.instructions.map(step => text(step, 15, 500, 'instructions.item')),
    tags,
    category: item.category as RecipeCategory, servings, totalMinutes,
  };
}

// These fixed public food assets are illustrative fallback art, never presented
// as photographs of the generated recipe. Keep source credit separate from
// recipe sourceUrl/sourceAuthor, which would falsely attribute the recipe.
export function fallbackRecipeImage(recipe: RecipeText): RecipeImage {
  const photo = recipe.category === 'Baked Goods' || recipe.category === 'Desserts' || recipe.category === 'Breakfast'
    ? { id: '1775043', url: 'https://www.pexels.com/photo/1775043/' }
    : /pasta|noodle|spaghetti/i.test(recipe.name)
      ? { id: '1279330', url: 'https://www.pexels.com/photo/1279330/' }
      : { id: '1640777', url: 'https://www.pexels.com/photo/flat-lay-photography-of-vegetable-salad-on-plate-1640777/' };
  return {
    photoURL: `https://images.pexels.com/photos/${photo.id}/pexels-photo-${photo.id}.jpeg?auto=compress&cs=tinysrgb&w=1024`,
    imageKind: 'illustrative-stock', imageAttribution: { label: 'Illustrative food photo · Pexels', url: photo.url },
  };
}

function allowedImageURL(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['firebasestorage.googleapis.com', 'images.pexels.com'].includes(url.hostname);
  } catch { return false; }
}

async function generateRecipeImage(recipe: RecipeText, recipeId: string): Promise<RecipeImage> {
  // No image client/request is constructed when the job has no configured key.
  if (!process.env.OPENAI_API_KEY) return fallbackRecipeImage(recipe);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 120_000 });
  const result = await client.images.generate({
    model: process.env.DISCOVERY_IMAGE_MODEL || 'gpt-image-2', n: 1, size: '1024x1024', quality: 'low', output_format: 'png',
    prompt: `Create an appetising editorial food illustration with realistic textures, soft natural light and a warm cream tabletop. Square composition, one finished dish, no people, text, logos or extra dishes. This is a generated visual concept, not documentation of a tested meal. Dish: ${recipe.name}. ${recipe.description} Visible ingredients: ${recipe.ingredients.map(ingredient => ingredient.name).join(', ')}. Only show ingredients in this recipe.`,
  });
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded || encoded.length > 28_000_000) throw new Error('IMAGE_INVALID');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 8 || bytes.length > 20_000_000 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('IMAGE_INVALID');
  // Use the same initialized Admin app/ADC as the API. Token URLs work without
  // object ACL changes, including on buckets with uniform access enabled.
  await import('./firebase');
  const { getStorage } = await import('firebase-admin/storage');
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'grocerease-5abbb.firebasestorage.app';
  const objectName = `discover/${recipeId}/${randomUUID()}.png`;
  const token = randomUUID();
  const file = getStorage().bucket(bucketName).file(objectName);
  await pipeline(Readable.from(bytes), file.createWriteStream({
    resumable: false, timeout: 30_000, preconditionOpts: { ifGenerationMatch: 0 },
    metadata: { contentType: 'image/png', cacheControl: 'public,max-age=31536000,immutable',
      metadata: { firebaseStorageDownloadTokens: token, imageKind: 'ai-generated' } },
  }), { signal: AbortSignal.timeout(30_000) });
  return {
    photoURL: `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectName)}?alt=media&token=${token}`,
    imageKind: 'ai-generated',
  };
}

/** Dependency injection keeps tests offline and prevents accidental paid calls. */
export function createCuratedRecipeGenerator(overrides: Partial<GeneratorDependencies> = {}) {
  const deps: GeneratorDependencies = {
    model: async () => (await import('./claude')).models.recipeGenerate,
    completeJson: async options => (await import('./claude')).completeJson(options),
    generateImage: generateRecipeImage, warn: message => console.warn(message), ...overrides,
  };
  return async ({ creator, recipeId, seed, recentTitles }: CuratedRecipeRequest): Promise<CuratedRecipeDraft> => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(recipeId) || !CURATED_CREATORS.some(item => item.uid === creator.uid) ||
        typeof seed !== 'string' || !seed || seed.length > 200 || !Array.isArray(recentTitles)) throw new CuratedGenerationError('INVALID_REQUEST', 'request');
    const recent = recentTitles.filter(title => typeof title === 'string').slice(-150).map(title => title.slice(0, 110));
    const result = await deps.completeJson({
      model: await deps.model(), system: SYSTEM, schema: RECIPE_SCHEMA, effort: 'medium', maxTokens: 4000,
      timeoutMs: 90_000, maxRetries: 0,
      user: JSON.stringify({ curator: creator.displayName, specialty: creator.specialty, editorialSeed: seed, recentTitles: recent }),
    });
    const recipe = validateCuratedRecipe(result, recent);
    let image: RecipeImage;
    try {
      image = await deps.generateImage(recipe, recipeId);
      if (!allowedImageURL(image.photoURL) || !['ai-generated', 'illustrative-stock'].includes(image.imageKind ?? '')) throw new Error('IMAGE_INVALID');
    } catch {
      // Provider errors can contain request data: do not log raw SDK exceptions.
      deps.warn(`Discover image unavailable for ${recipeId}; using attributed illustrative art.`);
      image = fallbackRecipeImage(recipe);
    }
    return { ...recipe, ...image };
  };
}

export const generateCuratedRecipe = createCuratedRecipeGenerator();
