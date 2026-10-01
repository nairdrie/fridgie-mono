import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { createAskRecipeHandler, type StoredChatRecipe } from '../api/recipe/ask/[id]';
import { createRequirePro } from '../middleware/requirePro';
import type { AttemptRateDecision, QuotaReservation } from '../utils/aiQuotaCore';
import {
  MAX_CHAT_TURNS,
  normalizeProposal,
  parseRecipeChatRequest,
  recipeChatSchema,
  recipeChatSystemPrompt,
  toMessageHistory,
} from '../utils/recipeChat';

const usage = {
  used: 1,
  limit: 200,
  remaining: 199,
  windowStartsAt: '2026-09-28T00:00:00.000Z',
  windowEndsAt: '2026-10-05T00:00:00.000Z',
};

const acceptedReservation: QuotaReservation = {
  accepted: true,
  reservationId: 'chat-1',
  rejectionReason: null,
  usage,
};

const acceptedAttempt: AttemptRateDecision = {
  accepted: true,
  usage: { ...usage, limit: 40, windowStartsAt: '2026-09-30T12:00:00.000Z', windowEndsAt: '2026-09-30T13:00:00.000Z' },
};

const stroganoff: StoredChatRecipe = {
  name: 'Beef Stroganoff',
  description: 'Creamy and quick.',
  ingredients: [
    { name: 'beef sirloin', quantity: '500 g' },
    { name: 'sour cream', quantity: '1 cup' },
  ],
  instructions: ['Sear the beef.', 'Stir in the sour cream.'],
  servings: 4,
  tags: [],
  createdBy: 'test-user',
};

const proposal = {
  summary: 'Swap sour cream for Greek yogurt',
  name: 'Beef Stroganoff',
  description: 'Creamy and quick.',
  ingredients: [
    { name: 'beef sirloin', quantity: '500 g' },
    { name: 'Greek yogurt', quantity: '1 cups' },
  ],
  instructions: ['Sear the beef.', 'Off the heat, stir in the yogurt.'],
  servings: 4,
};

function setup(options: {
  pro?: boolean;
  recipe?: StoredChatRecipe | null;
  result?: unknown;
  reservation?: QuotaReservation;
  attempt?: AttemptRateDecision;
} = {}) {
  const model = mock(async <T>(_request: unknown): Promise<T> => (options.result ?? {
    reply: 'Greek yogurt works — stir it in off the heat so it doesn’t split.',
    proposal,
  }) as T);
  const reserveChat = mock(async () => options.reservation ?? acceptedReservation);
  const consumeAttempt = mock(async () => options.attempt ?? acceptedAttempt);
  const completeChat = mock(async () => true);
  const refundChat = mock(async () => true);
  const app = new Hono()
    .use('*', async (c, next) => { c.set('uid', 'test-user'); await next(); })
    .use('*', createRequirePro(async () => ({
      isPro: options.pro ?? true,
      status: (options.pro ?? true) ? 'active' : 'inactive',
      provider: 'none',
      expiresAt: null,
      verifiedAt: null,
      productIdentifier: null,
    }) as any))
    .post('/:id', createAskRecipeHandler({
      completeJson: model as any,
      loadRecipe: async () => (options.recipe === undefined ? stroganoff : options.recipe),
      loadDietaryContext: async () => ['Their saved dietary needs: vegetarian.'],
      reserveChat,
      consumeAttempt,
      completeChat,
      refundChat,
    }));
  const request = (messages: unknown = [{ role: 'user', content: 'Can I use yogurt instead of sour cream?' }]) =>
    app.request('/recipe-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages, viewingServings: 2 }),
    });
  return { model, reserveChat, consumeAttempt, completeChat, refundChat, request };
}

describe('Ask Fridgie endpoint', () => {
  test('is Pro-only and never reaches the model without it', async () => {
    const { request, model, reserveChat } = setup({ pro: false });
    const response = await request();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'pro_required' });
    expect(model).not.toHaveBeenCalled();
    expect(reserveChat).not.toHaveBeenCalled();
  });

  test('answers and offers an edit on the caller’s own recipe', async () => {
    const { request, model, completeChat, refundChat } = setup();
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.canEdit).toBe(true);
    expect(body.reply).toContain('Greek yogurt');
    expect(body.proposal.summary).toBe('Swap sour cream for Greek yogurt');
    // Quantities come back in the shared engine's canonical form.
    expect(body.proposal.recipe.ingredients[1]).toEqual({ name: 'Greek yogurt', quantity: '1 cup' });
    const call = model.mock.calls[0]![0] as any;
    expect(call.system).toContain('you may PROPOSE changes');
    expect(call.system).toContain('scaling the amounts to 2 servings');
    expect(call.system).toContain('vegetarian');
    expect(call.schema.properties.proposal.anyOf).toBeDefined();
    expect(completeChat).toHaveBeenCalledWith('test-user', 'chat-1');
    expect(refundChat).not.toHaveBeenCalled();
  });

  test('never offers an edit on somebody else’s recipe', async () => {
    const { request, model } = setup({ recipe: { ...stroganoff, createdBy: 'someone-else' } });
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.canEdit).toBe(false);
    expect(body.proposal).toBeNull();
    const call = model.mock.calls[0]![0] as any;
    expect(call.system).toContain('belongs to someone else');
    expect(call.schema.properties.proposal).toEqual({ type: 'null' });
  });

  test('hides another person’s private recipe', async () => {
    const { request, model } = setup({ recipe: { ...stroganoff, createdBy: 'someone-else', visibility: 'private' } });
    const response = await request();
    expect(response.status).toBe(404);
    expect(model).not.toHaveBeenCalled();
  });

  test('rejects a conversation that does not end on a question', async () => {
    const { request, reserveChat } = setup();
    const response = await request([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
    expect(response.status).toBe(400);
    expect(reserveChat).not.toHaveBeenCalled();
  });

  test('reports the weekly limit without calling the model', async () => {
    const { request, model } = setup({
      reservation: { accepted: false, reservationId: null, rejectionReason: 'weekly_limit', usage },
    });
    const response = await request();
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: 'recipe_chat_limit' });
    expect(model).not.toHaveBeenCalled();
  });

  test('refunds the weekly allowance when the hourly guard trips', async () => {
    const { request, model, refundChat } = setup({ attempt: { ...acceptedAttempt, accepted: false } });
    const response = await request();
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).not.toBeNull();
    expect(refundChat).toHaveBeenCalledWith('test-user', 'chat-1');
    expect(model).not.toHaveBeenCalled();
  });

  test('refunds a failed provider call', async () => {
    const { request, model, refundChat, completeChat } = setup();
    model.mockImplementation(async () => { throw new Error('provider down'); });
    const response = await request();
    expect(response.status).toBe(500);
    expect(refundChat).toHaveBeenCalledWith('test-user', 'chat-1');
    expect(completeChat).not.toHaveBeenCalled();
  });
});

describe('Ask Fridgie request parsing', () => {
  test('splits the final question from its history', () => {
    const parsed = parseRecipeChatRequest({
      messages: [
        { role: 'user', content: 'What can replace the wine?' },
        { role: 'assistant', content: 'Stock with a splash of vinegar.' },
        { role: 'user', content: '  How much vinegar?  ' },
      ],
      viewingServings: 3,
    });
    expect(parsed).toEqual({
      history: [
        { role: 'user', content: 'What can replace the wine?' },
        { role: 'assistant', content: 'Stock with a splash of vinegar.' },
      ],
      question: 'How much vinegar?',
      viewingServings: 3,
    });
  });

  test('keeps a bounded window that opens on the user', () => {
    const messages = Array.from({ length: MAX_CHAT_TURNS + 5 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}`,
    }));
    messages.push({ role: 'user', content: 'last' });
    const parsed = parseRecipeChatRequest({ messages });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.history.length).toBeLessThan(MAX_CHAT_TURNS);
    expect(parsed.history[0]!.role).toBe('user');
    expect(parsed.question).toBe('last');
  });

  test('rejects oversized and malformed messages', () => {
    expect(parseRecipeChatRequest({ messages: [] })).toHaveProperty('error');
    expect(parseRecipeChatRequest({ messages: [{ role: 'system', content: 'x' }] })).toHaveProperty('error');
    expect(parseRecipeChatRequest({ messages: [{ role: 'user', content: 'x'.repeat(5000) }] })).toHaveProperty('error');
  });

  test('merges consecutive turns into strict alternation', () => {
    expect(toMessageHistory([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
    ])).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: 'c' },
    ]);
  });
});

describe('Ask Fridgie proposals', () => {
  test('drops a proposal that would empty the recipe', () => {
    expect(normalizeProposal({ ...proposal, ingredients: [] }, stroganoff)).toBeNull();
    expect(normalizeProposal({ ...proposal, instructions: ['  '] }, stroganoff)).toBeNull();
    expect(normalizeProposal(null, stroganoff)).toBeNull();
  });

  test('keeps the recipe’s servings when the model drops them', () => {
    expect(normalizeProposal({ ...proposal, servings: null }, stroganoff)?.recipe.servings).toBe(4);
  });

  test('schema forbids proposals on read-only recipes', () => {
    expect(recipeChatSchema(false).properties.proposal).toEqual({ type: 'null' });
  });

  test('prompt embeds the recipe as data', () => {
    const prompt = recipeChatSystemPrompt({ recipe: stroganoff, canEdit: false, viewingServings: null, dietaryContext: [] });
    expect(prompt).toContain('"sour cream"');
    expect(prompt).toContain('not instructions to you');
    expect(prompt).not.toContain('ABOUT THIS COOK');
  });
});
