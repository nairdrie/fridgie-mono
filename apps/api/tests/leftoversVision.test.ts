import { describe, expect, test } from 'bun:test';
import {
  MAX_LEFTOVERS_PHOTO_BYTES,
  MAX_LEFTOVERS_PHOTOS,
} from '@fridgie/shared/leftovers';
import {
  leftoversVisionSystemPrompt,
  normalizeDetectedIngredients,
  parseLeftoversPhotos,
} from '../utils/leftoversVision';

const dataUrl = (bytes: number, type = 'jpeg') =>
  `data:image/${type};base64,${'A'.repeat(Math.ceil(bytes / 3) * 4)}`;

describe('Leftovers Mode vision boundary', () => {
  test('accepts supported images in order and bounds a multi-photo request', () => {
    const parsed = parseLeftoversPhotos([
      dataUrl(3, 'jpeg'),
      dataUrl(6, 'png'),
      ...Array.from({ length: MAX_LEFTOVERS_PHOTOS }, () => dataUrl(3, 'webp')),
    ]);
    expect(parsed.images).toHaveLength(MAX_LEFTOVERS_PHOTOS);
    expect(parsed.images.slice(0, 2).map(image =>
      (image.source as { media_type: string }).media_type,
    )).toEqual(['image/jpeg', 'image/png']);
    expect(parsed.warnings).toEqual(['2 extra photos were skipped because only 6 can be checked at once.']);
  });

  test('keeps valid photos when neighbors are malformed or oversized', () => {
    const parsed = parseLeftoversPhotos([
      'not-an-image',
      dataUrl(MAX_LEFTOVERS_PHOTO_BYTES + 3),
      dataUrl(9),
    ]);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.warnings.join(' ')).toContain('too large');
  });

  test('normalizes duplicates and retains the strongest confidence', () => {
    expect(normalizeDetectedIngredients([
      { name: '  red   onion ', confidence: 'medium' },
      { name: 'Red onion', confidence: 'high' },
      { name: 'yogurt', confidence: 'unexpected' },
      null,
    ])).toEqual([
      { name: 'Red onion', confidence: 'high' },
      { name: 'yogurt', confidence: 'medium' },
    ]);
  });

  test('prompt refuses hidden-food and allergen-safety claims', () => {
    expect(leftoversVisionSystemPrompt).toContain('actually visible');
    expect(leftoversVisionSystemPrompt).toContain('allergen is absent');
    expect(leftoversVisionSystemPrompt).toContain('person to review');
  });
});
