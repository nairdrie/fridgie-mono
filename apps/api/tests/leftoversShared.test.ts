import { describe, expect, test } from 'bun:test';
import { base64ByteLength, MAX_LEFTOVERS_INGREDIENTS, normalizeLeftoversIngredients } from '@fridgie/shared/leftovers';

describe('leftovers shared boundaries', () => {
  test('computes decoded base64 byte length including padding', () => {
    expect(base64ByteLength('TQ==')).toBe(1);
    expect(base64ByteLength('TWE=')).toBe(2);
    expect(base64ByteLength('TWFu')).toBe(3);
  });

  test('normalizes, de-duplicates and bounds confirmed ingredients', () => {
    const values = ['  Red   onion ', 'red onion', '', 42, ...Array.from({ length: 100 }, (_, i) => `item ${i}`)];
    const result = normalizeLeftoversIngredients(values);
    expect(result[0]).toBe('Red onion');
    expect(result.filter(value => value.toLowerCase() === 'red onion')).toHaveLength(1);
    expect(result).toHaveLength(MAX_LEFTOVERS_INGREDIENTS);
  });
});
