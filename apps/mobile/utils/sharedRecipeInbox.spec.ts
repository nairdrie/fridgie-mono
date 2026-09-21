import { describe, expect, test } from 'bun:test';
import { appendSharedRecipe, decodeSharedRecipeInbox, removeSharedRecipe } from './sharedRecipeInbox';

const first = { id: 'first', input: 'https://www.instagram.com/reel/Recipe123/', receivedAt: 1 };
const second = { id: 'second', input: 'https://vm.tiktok.com/Recipe/', receivedAt: 2 };

describe('shared recipe inbox', () => {
  test('restores pending links through an app restart or sign-in', () => {
    expect(decodeSharedRecipeInbox(JSON.stringify([first, second]))).toEqual([first, second]);
  });
  test('ignores corrupt storage and malformed records', () => {
    expect(decodeSharedRecipeInbox('{')).toEqual([]);
    expect(decodeSharedRecipeInbox(JSON.stringify([first, first, {}, { ...second, input: '' }]))).toEqual([first]);
  });
  test('does not duplicate an import on repeated native events', () => {
    expect(appendSharedRecipe([first], { ...first, id: 'duplicate' })).toEqual([first]);
  });
  test('queues another share without overwriting the draft being reviewed', () => {
    expect(appendSharedRecipe([first], second)).toEqual([first, second]);
    expect(removeSharedRecipe([first, second], first.id)).toEqual([second]);
  });
  test('the same recipe can deliberately be shared again after dismissal', () => {
    expect(appendSharedRecipe(removeSharedRecipe([first], first.id), { ...first, id: 'again' })).toEqual([{ ...first, id: 'again' }]);
  });
  test('rejects oversized native text without changing the inbox', () => {
    expect(() => appendSharedRecipe([first], { ...second, input: 'a'.repeat(16_001) })).toThrow();
  });
});
