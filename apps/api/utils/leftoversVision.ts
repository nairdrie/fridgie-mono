import type Anthropic from '@anthropic-ai/sdk';
import {
  base64ByteLength,
  MAX_LEFTOVERS_INGREDIENTS,
  MAX_LEFTOVERS_PHOTO_BYTES,
  MAX_LEFTOVERS_PHOTOS,
  MAX_LEFTOVERS_UPLOAD_BYTES,
  normalizeLeftoversIngredients,
} from '@fridgie/shared/leftovers';

const DATA_URL_RE = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

const mediaTypes = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;

export interface ParsedLeftoversPhotos {
  images: Anthropic.ImageBlockParam[];
  warnings: string[];
  totalBytes: number;
}

/**
 * Parse photos independently. If one member of a multi-select is corrupt or
 * oversized, useful photos still reach the model and the response tells the
 * client that the set was partial.
 */
export function parseLeftoversPhotos(value: unknown): ParsedLeftoversPhotos {
  if (!Array.isArray(value)) return { images: [], warnings: ['No photos were provided.'], totalBytes: 0 };

  const images: Anthropic.ImageBlockParam[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;

  value.slice(0, MAX_LEFTOVERS_PHOTOS).forEach((candidate, index) => {
    const label = `Photo ${index + 1}`;
    if (typeof candidate !== 'string') {
      warnings.push(`${label} could not be read.`);
      return;
    }

    const match = candidate.match(DATA_URL_RE);
    if (!match) {
      warnings.push(`${label} was not a supported JPEG, PNG or WebP image.`);
      return;
    }
    const bytes = base64ByteLength(match[2]!);
    if (!bytes) {
      warnings.push(`${label} was empty.`);
      return;
    }
    if (bytes > MAX_LEFTOVERS_PHOTO_BYTES) {
      warnings.push(`${label} was too large after compression.`);
      return;
    }
    if (totalBytes + bytes > MAX_LEFTOVERS_UPLOAD_BYTES) {
      warnings.push(`${label} was skipped because the combined upload was too large.`);
      return;
    }

    const format = match[1]!.toLowerCase() as keyof typeof mediaTypes;
    images.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaTypes[format], data: match[2]! },
    });
    totalBytes += bytes;
  });

  if (value.length > MAX_LEFTOVERS_PHOTOS) {
    const extra = value.length - MAX_LEFTOVERS_PHOTOS;
    warnings.push(`${extra} extra photo${extra === 1 ? ' was' : 's were'} skipped because only ${MAX_LEFTOVERS_PHOTOS} can be checked at once.`);
  }

  return { images, warnings, totalBytes };
}

export type IngredientConfidence = 'high' | 'medium';

export interface ModelIngredient {
  name: string;
  confidence: IngredientConfidence;
}

export interface DetectedIngredient extends ModelIngredient {}

export function normalizeDetectedIngredients(value: unknown): DetectedIngredient[] {
  if (!Array.isArray(value)) return [];

  const firstByName = new Map<string, DetectedIngredient>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as { name?: unknown; confidence?: unknown };
    const [name] = normalizeLeftoversIngredients([candidate.name]);
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    const confidence: IngredientConfidence = candidate.confidence === 'high' ? 'high' : 'medium';
    const previous = firstByName.get(key);
    if (!previous || (previous.confidence === 'medium' && confidence === 'high')) {
      firstByName.set(key, { name, confidence });
    }
    if (firstByName.size === MAX_LEFTOVERS_INGREDIENTS) break;
  }

  return [...firstByName.values()];
}

export const leftoversVisionSchema = {
  type: 'object',
  properties: {
    ingredients: {
      type: 'array',
      maxItems: MAX_LEFTOVERS_INGREDIENTS,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A concise, ordinary ingredient name.' },
          confidence: { type: 'string', enum: ['high', 'medium'] },
        },
        required: ['name', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['ingredients'],
  additionalProperties: false,
} as const;

export const leftoversVisionSystemPrompt = `
You identify visible food ingredients in photos of a fridge, freezer, pantry or
kitchen counter. Return a single de-duplicated inventory across every photo.

Include foods, condiments and usable leftovers that are actually visible. Use
short everyday names. If a food is clear, confidence is high. If only its broad
category is defensible, use that category with medium confidence (for example
"leafy greens" rather than inventing spinach). Omit anything too ambiguous to
be useful. Do not infer food hidden inside opaque containers and do not treat a
brand name as an ingredient.

This is only a draft for the person to review. Never claim that a photo proves
an allergen is absent, that food is safe to eat, or that an ingredient is fresh.
`;
