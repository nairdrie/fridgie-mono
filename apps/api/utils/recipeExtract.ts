// Getting a recipe out of a web page: the site's own schema.org markup first,
// its raw markup second.
//
// Recipe sites publish this markup because it is what earns a Google rich
// result, so on a real recipe page the ingredients and steps are already sitting
// there as structured data. The importer used to throw it away —
// `$('script, ...').remove()` ran first and JSON-LD lives in a <script> — and
// then paid Sonnet to reconstruct the same fields from the surrounding markup.
//
// What comes back here is deliberately still *source* data, not a Recipe: the
// ingredient lines are freeform ("1 1/2 cups Green cabbage, thinly sliced") and
// splitting those into name + quantity is a judgement call the model makes
// downstream. The win is that extraction stops being a guess.

import * as cheerio from 'cheerio';

/** What a page's own markup claims about the recipe, before interpretation. */
export interface SourceRecipe {
  name: string | null;
  description: string | null;
  /** Freeform lines exactly as published — "8 oz Ground pork, 20–30% fat preferred". */
  ingredients: string[];
  instructions: string[];
  photoURL: string | null;
  /** `keywords`, `recipeCategory` and `recipeCuisine` merged — all tag candidates. */
  keywords: string[];
  recipeYield: string | null;
  totalTime: string | null;
}

/** Nested containers are walked, but a hostile or cyclic document should not hang us. */
const MAX_WALK_DEPTH = 6;
/** Sites occasionally publish an entire cookbook in one blob; we only need one recipe. */
const MAX_NODES = 500;

/** `@type` is a string on most sites and an array on the ones that dual-purpose a page. */
const typesOf = (node: Record<string, unknown>): string[] => {
  const raw = node['@type'];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  return [];
};

const isRecipeNode = (node: unknown): node is Record<string, unknown> =>
  !!node
  && typeof node === 'object'
  && !Array.isArray(node)
  && typesOf(node as Record<string, unknown>).some((t) => t.toLowerCase() === 'recipe');

/**
 * Publishers nest the Recipe in every container the spec allows: a bare object,
 * an array, an `@graph`, or hung off `mainEntity`/`mainEntityOfPage` of a
 * WebPage or Article. Walk the lot rather than special-casing each shape.
 */
function findRecipeNode(root: unknown): Record<string, unknown> | null {
  const queue: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  let seen = 0;

  while (queue.length > 0 && seen < MAX_NODES) {
    const { node, depth } = queue.shift()!;
    if (!node || typeof node !== 'object' || depth > MAX_WALK_DEPTH) continue;
    seen += 1;

    if (Array.isArray(node)) {
      for (const child of node) queue.push({ node: child, depth: depth + 1 });
      continue;
    }
    if (isRecipeNode(node)) return node;

    // Only descend through the keys that can legitimately hold a Recipe. A blind
    // walk of every value drags in review bodies and breadcrumb trails, and on a
    // long page that is where the node budget goes.
    for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'hasPart']) {
      const child = (node as Record<string, unknown>)[key];
      if (child) queue.push({ node: child, depth: depth + 1 });
    }
  }
  return null;
}

/** Strip the markup sites embed inside JSON-LD string values, and collapse whitespace. */
const plain = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const text = value.includes('<') ? cheerio.load(`<div>${value}</div>`)('div').text() : value;
  return text.replace(/\s+/g, ' ').trim();
};

/** `image` is a URL, an ImageObject, or an array of either — take the first usable one. */
function firstImageUrl(value: unknown, depth = 0): string | null {
  if (depth > 3 || !value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstImageUrl(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return firstImageUrl(obj.url ?? obj.contentUrl ?? obj['@id'], depth + 1);
  }
  return null;
}

/**
 * `recipeInstructions` is the messiest field in the vocabulary: a single string,
 * an array of strings, HowToStep objects, or HowToSection objects that hold
 * their own `itemListElement` list of steps. Flatten to text, keeping order.
 *
 * A lone string is passed through whole rather than split on guessed sentence
 * boundaries — the model reads this next and is better at deciding where one
 * step ends than a regex is.
 */
function flattenInstructions(value: unknown, depth = 0): string[] {
  if (depth > 3 || !value) return [];
  if (typeof value === 'string') {
    // Some sites put every step in one string separated by newlines. That split
    // is safe; splitting on "." is not (it shatters "Heat to 180 C. approx").
    return value
      .split(/\r?\n+/)
      .map(plain)
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(value)) return value.flatMap((entry) => flattenInstructions(entry, depth + 1));
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.itemListElement) return flattenInstructions(obj.itemListElement, depth + 1);
    const text = plain(obj.text ?? obj.name ?? obj.description);
    return text ? [text] : [];
  }
  return [];
}

/**
 * A list of whole values. Used for anything whose entries are freeform prose —
 * an ingredient line is one item however many commas it contains, and splitting
 * "8 oz Ground pork, 20-30% fat preferred" into two ingredients is exactly the
 * kind of quiet corruption this importer exists to stop.
 */
const toLineList = (value: unknown): string[] => {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(toLineList);
  if (typeof value === 'object') {
    const named = plain((value as Record<string, unknown>).name);
    return named ? [named] : [];
  }
  return [];
};

/** `keywords` is specified as one comma-separated string, but published both ways. */
const toKeywordList = (value: unknown): string[] =>
  toLineList(value).flatMap((entry) => entry.split(',').map((s) => s.trim())).filter(Boolean);

/**
 * Parse one <script type="application/ld+json"> body.
 *
 * Invalid JSON-LD is common enough in the wild that a throw here would take out
 * pages whose *other* blocks are fine, so a bad block is skipped, not fatal.
 */
function parseBlock(raw: string): unknown | null {
  const cleaned = raw
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * Pull the first schema.org Recipe out of a page, or null if it has none.
 *
 * Call this on the RAW html, before the <script> tags are stripped.
 */
export function extractRecipeJsonLd(html: string): SourceRecipe | null {
  const $ = cheerio.load(html);
  const blocks = $('script[type="application/ld+json"]').toArray();

  for (const block of blocks) {
    const parsed = parseBlock($(block).contents().text());
    if (!parsed) continue;

    const node = findRecipeNode(parsed);
    if (!node) continue;

    // `ingredients` is the pre-2017 spelling; enough sites still emit it that
    // ignoring it would drop otherwise perfectly good markup.
    const ingredients = toLineList(node.recipeIngredient ?? node.ingredients)
      .map(plain)
      .filter(Boolean);
    const instructions = flattenInstructions(node.recipeInstructions);

    // A Recipe node carrying neither is a stub — some sites emit one on category
    // and index pages purely for the breadcrumb. Keep looking; the real one may
    // be in a later block, and failing that the HTML path still runs.
    if (ingredients.length === 0 && instructions.length === 0) continue;

    return {
      name: plain(node.name) || null,
      description: plain(node.description) || null,
      ingredients,
      instructions,
      photoURL: firstImageUrl(node.image),
      keywords: [
        ...toKeywordList(node.keywords),
        ...toKeywordList(node.recipeCategory),
        ...toKeywordList(node.recipeCuisine),
      ],
      recipeYield: toLineList(node.recipeYield).map(plain).filter(Boolean)[0] ?? null,
      totalTime: plain(node.totalTime) || null,
    };
  }

  return null;
}

// --- FALLBACK: THE PAGE'S OWN MARKUP ---
//
// Only reached when a page publishes no usable Recipe markup. Everything below
// is a worse deal than the JSON-LD above — it costs a large model call and the
// model has to infer structure that was never stated — but plenty of small
// blogs still hand-roll their recipe pages.

/**
 * Where a page's main content tends to live. Order is only a tie-break;
 * `extractMainContent` picks by how much text each one actually holds.
 */
const CONTENT_SELECTORS = ['main', '[role="main"]', 'article', '#main-content', '.recipe', 'body'];

/** Below this much visible text a page has nothing worth spending a model call on. */
const MIN_CONTENT_TEXT = 200;

/**
 * The markup most likely to hold the recipe, or null if the page has nothing
 * readable on it.
 *
 * Picks by text volume rather than by first match. The old chain was
 * `$('main').html() || $('article').html() || ...`, which takes the first
 * TRUTHY result — and on a streaming React page `<main>` is server-rendered as
 * nothing but Suspense placeholders. Once <template> was stripped that left
 * `<!--$?--><!--/$-->`: eighteen characters, truthy, so the chain stopped there
 * and the caller's length guard rejected the page. Every Next.js App Router
 * recipe site failed this way, in under two seconds, without ever reaching the
 * model.
 */
export function extractMainContent(html: string): string | null {
  const $ = cheerio.load(html);

  // Strip what cannot contain a recipe before anything is measured or sent.
  // On an ad-heavy blog this is most of the bytes, and every one of them was
  // being billed as input tokens. Deliberately conservative: nav/header/
  // footer/aside stay, because recipe sites routinely put the title or the
  // ingredient card inside them.
  $('script, style, noscript, svg, iframe, link, meta, template').remove();

  let best: { html: string; textLength: number } | null = null;

  for (const selector of CONTENT_SELECTORS) {
    // `.html()` returns only the first match's markup, so measure that same
    // element — summing the text of all five <article> cards on a page and then
    // extracting only one of them would compare two different things.
    const element = $(selector).first();
    const html = element.html();
    if (!html) continue;

    const textLength = element.text().replace(/\s+/g, ' ').trim().length;
    if (!best || textLength > best.textLength) best = { html, textLength };
  }

  return best && best.textLength >= MIN_CONTENT_TEXT ? best.html : null;
}
