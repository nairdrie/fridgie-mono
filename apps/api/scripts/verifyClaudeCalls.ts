// Offline check of the Claude request payloads. Intercepts fetch so it runs
// without credentials, and asserts the wire body matches what the structured-
// outputs and vision APIs require. Run: bun scripts/verifyClaudeCalls.ts
import { importedRecipeSchema, recipeSchema } from '@/utils/recipePrompts';

let captured: any = null;
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: any, init: any) => {
  captured = JSON.parse(init.body);
  return new Response(
    JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5',
      content: [
        { type: 'thinking', thinking: '', signature: 'x' },
        { type: 'text', text: JSON.stringify({ ok: true }) },
      ],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } },
  );
}) as typeof fetch;

const failures: string[] = [];
const check = (label: string, cond: boolean) => {
  if (!cond) failures.push(label);
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
};

/** Structured outputs reject unconstrained objects and several JSON Schema keywords. */
function auditSchema(node: any, path = '$'): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'object') {
    check(`${path} sets additionalProperties:false`, node.additionalProperties === false);
    const props = Object.keys(node.properties ?? {});
    const required = node.required ?? [];
    check(`${path} requires every property`, props.every((p) => required.includes(p)));
  }
  for (const banned of ['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf']) {
    if (banned in node) failures.push(`${path} uses unsupported keyword "${banned}"`);
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties') for (const [pk, pv] of Object.entries(v as any)) auditSchema(pv, `${path}.${pk}`);
    else if (k === 'items') auditSchema(v, `${path}[]`);
    else if (k === 'anyOf') (v as any[]).forEach((s, i) => auditSchema(s, `${path}|${i}`));
  }
}

console.log('--- schema audit ---');
auditSchema(recipeSchema, 'recipe');
auditSchema(importedRecipeSchema, 'importedRecipe');

// Imported only now: the SDK binds `fetch` when the client is constructed, so
// the module has to load after the patch above is in place.
const { completeJson, models } = await import('@/utils/claude');

console.log('\n--- text request ---');
await completeJson({
  model: 'claude-opus-5',
  system: 'system text',
  user: 'user text',
  schema: recipeSchema as any,
  effort: 'low',
});
check('model is claude-opus-5', captured.model === 'claude-opus-5');
check('no temperature/top_p/top_k (400 on Opus 5)',
  !('temperature' in captured) && !('top_p' in captured) && !('top_k' in captured));
check('no budget_tokens (400 on Opus 5)', JSON.stringify(captured).indexOf('budget_tokens') === -1);
check('output_config.format is json_schema', captured.output_config?.format?.type === 'json_schema');
check('output_config.effort passed through', captured.output_config?.effort === 'low');
check('system carries a cache breakpoint', captured.system?.[0]?.cache_control?.type === 'ephemeral');
check('no assistant prefill turn', captured.messages.every((m: any) => m.role === 'user'));

console.log('\n--- vision request ---');
await completeJson({
  model: 'claude-opus-5',
  system: 'photo system',
  user: [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
    { type: 'text', text: 'Extract the recipe from this photo.' },
  ],
  schema: importedRecipeSchema as any,
  effort: 'medium',
});
const blocks = captured.messages[0].content;
check('image block uses base64 source', blocks[0].type === 'image' && blocks[0].source.type === 'base64');
check('image block carries media_type', blocks[0].source.media_type === 'image/jpeg');
check('no OpenAI-style image_url block', JSON.stringify(blocks).indexOf('image_url') === -1);

console.log('\n--- effort guard (Haiku rejects the effort param) ---');
await completeJson({
  model: models.categorize,
  system: 'sort things',
  user: 'items',
  schema: recipeSchema as any,
  effort: 'low',
});
check(`categorize model is ${models.categorize}`, captured.model === models.categorize);
check('no effort sent to Haiku', captured.output_config?.effort === undefined);
check('schema still sent to Haiku', captured.output_config?.format?.type === 'json_schema');

await completeJson({
  model: models.mealSuggest,
  system: 'suggest',
  user: 'dinner',
  schema: recipeSchema as any,
  effort: 'medium',
});
check(`suggest model is ${models.mealSuggest}`, captured.model === models.mealSuggest);
check('effort IS sent to Sonnet', captured.output_config?.effort === 'medium');

globalThis.fetch = realFetch;
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
