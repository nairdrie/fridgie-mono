import { createHash } from 'node:crypto';
import type {
  CookbookPrintDraft,
  CookbookPrintDraftInput,
  CookbookPrintEligibleRecipe,
  CookbookPrintFulfillmentStatus,
  CookbookPrintIssue,
  CookbookPrintPaymentStatus,
  CookbookPrintQuote,
  CookbookPrintRecipeSelection,
  CookbookPrintRestriction,
  CookbookPrintRightsMode,
  CookbookPrintSku,
  CookbookPrintTheme,
  Recipe,
} from '@fridgie/shared/types';

export const COOKBOOK_PRINT_POLICY_VERSION = 1;
export const COOKBOOK_PRINT_LAYOUT_VERSION = '1.0.0';
export const COOKBOOK_PRINT_MIN_RECIPES = 1;
export const COOKBOOK_PRINT_MILESTONE = 12;
export const COOKBOOK_PRINT_MIN_PAGES = 32;
export const COOKBOOK_PRINT_MAX_PAGES = 800;

/** The user-facing builder stays hidden until storage and provider boundaries
 * have passed the deployment checks and the runtime is explicitly enabled. */
export function cookbookPrintFeatureAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PRINT_COMMERCE_ENABLED?.trim().toLowerCase() === 'true';
}
/** 7 x 10 trim plus Lulu's required 0.125 inch full bleed on every edge. */
export const INTERIOR_WIDTH_PT = 7.25 * 72;
export const INTERIOR_HEIGHT_PT = 10.25 * 72;
/** Logical composition canvas; the PDF renderer scales it to the bleed box. */
export const LAYOUT_WIDTH_PT = 612;
export const LAYOUT_HEIGHT_PT = 792;

export interface CookbookPrintSnapshotRecipe {
  recipeId: string;
  name: string;
  description: string;
  ingredients: Array<{ name: string; quantity: string }>;
  instructions: string[];
  servings?: number;
  category?: string;
  photoURL?: string;
  sourceUrl?: string;
  sourceAuthor?: string;
  authorName?: string;
  createdBy?: string;
  position: number;
  section: string;
  photoPlacement: 'auto' | 'hero' | 'inline' | 'none';
  rightsMode: CookbookPrintRightsMode;
  restriction: CookbookPrintRestriction;
  notes?: string;
  rightsConfirmedAt?: string;
  contentMode: 'full' | 'source-only';
}

export interface CookbookPrintSnapshot {
  id: string;
  ownerUid: string;
  draftId: string;
  policyVersion: number;
  layoutVersion: string;
  createdAt: string;
  title: string;
  subtitle?: string;
  dedication?: string;
  byline: string;
  theme: CookbookPrintTheme;
  sku: CookbookPrintSku;
  coverRecipeId?: string;
  coverCrop: { x: number; y: number; zoom: number };
  includeTableOfContents: boolean;
  includeIndex: boolean;
  recipes: CookbookPrintSnapshotRecipe[];
  contentHash: string;
}

export type PrintElement =
  | { kind: 'text'; x: number; top: number; width: number; fontSize: number; lineHeight: number; lines: string[]; color: string; align?: 'left' | 'center' | 'right'; role?: string }
  | { kind: 'rect'; x: number; top: number; width: number; height: number; color: string; radius?: number }
  | { kind: 'rule'; x: number; top: number; width: number; color: string; thickness?: number }
  | { kind: 'image'; recipeId: string; url: string; x: number; top: number; width: number; height: number; crop: { x: number; y: number; zoom: number }; role: 'cover' | 'hero' | 'inline' }
  | { kind: 'qr'; value: string; x: number; top: number; size: number };

export interface CookbookPrintPagePlan {
  pageNumber: number;
  kind: 'title' | 'dedication' | 'contents' | 'section' | 'recipe' | 'source' | 'index' | 'notes';
  label: string;
  recipeId?: string;
  section?: string;
  elements: PrintElement[];
}

export interface CookbookPrintLayoutPlan {
  width: number;
  height: number;
  theme: CookbookPrintTheme;
  pages: CookbookPrintPagePlan[];
  spineWidthInches: number;
  issues: CookbookPrintIssue[];
}

const THEMES: Record<CookbookPrintTheme, { paper: string; ink: string; muted: string; accent: string; wash: string }> = {
  classic: { paper: '#FFFDF7', ink: '#2E342F', muted: '#6F746F', accent: '#947650', wash: '#F0E8D9' },
  modern: { paper: '#F8F8F3', ink: '#173F35', muted: '#687A70', accent: '#23785E', wash: '#DCEDE2' },
  'photo-forward': { paper: '#FFFBF7', ink: '#173F35', muted: '#687A70', accent: '#C97860', wash: '#F3DED5' },
};

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown, max: number, fallback = ''): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export function recipePrintRestriction(ownerUid: string, recipe: Recipe): {
  restriction: CookbookPrintRestriction;
  defaultRightsMode: CookbookPrintRightsMode;
  photoPrintAllowedByDefault: boolean;
  message?: string;
} {
  // Fridgie-created editorial recipes carry their own managed provenance. They
  // are not treated like a random public recipe merely because createdBy is a
  // curated profile rather than this user.
  if (recipe.contentOrigin === 'ai-curated' || recipe.contentOrigin === 'ai-adapted') {
    return { restriction: 'none', defaultRightsMode: 'original-or-licensed', photoPrintAllowedByDefault: recipe.imageKind === 'ai-generated' };
  }
  if (recipe.contentOrigin === 'photo-imported') {
    return {
      restriction: 'photo-import', defaultRightsMode: 'source-only', photoPrintAllowedByDefault: false,
      message: 'This recipe was read from a photographed page. Print only your notes unless you hold print rights to the original text and image.',
    };
  }
  if (recipe.sourceUrl || recipe.sourceKey) {
    return {
      restriction: 'external-source', defaultRightsMode: 'source-only', photoPrintAllowedByDefault: false,
      message: 'This recipe came from another source. Print attribution and your notes unless you hold print rights to its text and photo.',
    };
  }
  if (recipe.createdBy && recipe.createdBy !== ownerUid) {
    return {
      restriction: 'contributor-permission', defaultRightsMode: 'source-only', photoPrintAllowedByDefault: false,
      message: 'Ask the contributor for permission, or print only the title, credit, and your notes.',
    };
  }
  return { restriction: 'none', defaultRightsMode: 'original-or-licensed', photoPrintAllowedByDefault: true };
}

export function printableCookbook(ownerUid: string, recipes: Recipe[]): CookbookPrintEligibleRecipe[] {
  return recipes
    // A guessed private recipe id must never become printable merely because it
    // was inserted into a cookbook entry. Own private recipes are valid.
    .filter(recipe => recipe.createdBy === ownerUid || recipe.visibility !== 'private')
    .map(recipe => {
      const rights = recipePrintRestriction(ownerUid, recipe);
      return {
        ...recipe,
        printRestriction: rights.restriction,
        printRestrictionMessage: rights.message,
        defaultRightsMode: rights.defaultRightsMode,
        photoPrintAllowedByDefault: rights.photoPrintAllowedByDefault,
      };
    });
}

export function defaultDraftInput(displayName: string, recipes: CookbookPrintEligibleRecipe[]): CookbookPrintDraftInput {
  const ownerName = displayName.trim();
  return {
    title: ownerName ? `${ownerName}'s Cookbook` : 'My Cookbook',
    subtitle: 'Recipes worth keeping',
    dedication: '',
    byline: ownerName || 'Fridgie cook',
    theme: 'classic',
    sku: 'matte-softcover',
    coverRecipeId: recipes.find(recipe => recipe.photoURL && recipe.photoPrintAllowedByDefault)?.id,
    coverCrop: { x: 0.5, y: 0.5, zoom: 1 },
    includeTableOfContents: true,
    includeIndex: true,
    recipes: recipes.map((recipe, position) => ({
      recipeId: recipe.id,
      included: true,
      position,
      section: recipe.category || 'Other',
      photoPlacement: 'auto',
      rightsMode: recipe.defaultRightsMode,
    })),
  };
}

export function sanitizeDraftInput(raw: unknown, availableRecipeIds?: ReadonlySet<string>): CookbookPrintDraftInput {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const recipeValues = Array.isArray(value.recipes) ? value.recipes : [];
  const seen = new Set<string>();
  const recipes: CookbookPrintRecipeSelection[] = [];
  for (const [index, candidate] of recipeValues.entries()) {
    if (!candidate || typeof candidate !== 'object') continue;
    const row = candidate as Record<string, unknown>;
    const recipeId = text(row.recipeId, 200);
    if (!recipeId || seen.has(recipeId) || (availableRecipeIds && !availableRecipeIds.has(recipeId))) continue;
    seen.add(recipeId);
    recipes.push({
      recipeId,
      included: row.included !== false,
      position: Math.max(0, Math.floor(finite(row.position, index))),
      section: text(row.section, 80) || undefined,
      photoPlacement: oneOf(row.photoPlacement, ['auto', 'hero', 'inline', 'none'] as const, 'auto'),
      rightsMode: oneOf(row.rightsMode, ['original-or-licensed', 'source-only', 'rights-confirmed'] as const, 'source-only'),
      notes: text(row.notes, 2_000) || undefined,
      rightsConfirmedAt: text(row.rightsConfirmedAt, 40) || undefined,
    });
  }
  recipes.sort((a, b) => a.position - b.position || a.recipeId.localeCompare(b.recipeId));
  recipes.forEach((recipe, position) => { recipe.position = position; });
  const coverX = Math.min(1, Math.max(0, finite((value.coverCrop as any)?.x, 0.5)));
  const coverY = Math.min(1, Math.max(0, finite((value.coverCrop as any)?.y, 0.5)));
  const coverZoom = Math.min(3, Math.max(1, finite((value.coverCrop as any)?.zoom, 1)));
  return {
    title: text(value.title, 120, 'My Cookbook'),
    subtitle: text(value.subtitle, 180) || undefined,
    dedication: text(value.dedication, 1_000) || undefined,
    byline: text(value.byline, 100, 'Fridgie cook'),
    theme: oneOf(value.theme, ['classic', 'modern', 'photo-forward'] as const, 'classic'),
    sku: oneOf(value.sku, ['matte-softcover', 'matte-hardcover'] as const, 'matte-softcover'),
    coverRecipeId: text(value.coverRecipeId, 200) || undefined,
    coverCrop: { x: coverX, y: coverY, zoom: coverZoom },
    includeTableOfContents: value.includeTableOfContents !== false,
    includeIndex: value.includeIndex !== false,
    recipes,
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function cookbookPrintHash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export function createCookbookPrintSnapshot(options: {
  id: string;
  ownerUid: string;
  draft: CookbookPrintDraft;
  recipes: Recipe[];
  now?: Date;
}): CookbookPrintSnapshot {
  const byId = new Map(options.recipes.map(recipe => [recipe.id, recipe]));
  const selected = options.draft.recipes.filter(item => item.included).sort((a, b) => a.position - b.position);
  if (selected.length < COOKBOOK_PRINT_MIN_RECIPES) throw Object.assign(new Error('Choose at least one recipe.'), { code: 'NO_RECIPES' });
  const recipes = selected.map((selection, position): CookbookPrintSnapshotRecipe => {
    const recipe = byId.get(selection.recipeId);
    if (!recipe || (recipe.visibility === 'private' && recipe.createdBy !== options.ownerUid)) {
      throw Object.assign(new Error('A selected recipe is no longer available.'), { code: 'RECIPE_UNAVAILABLE', recipeId: selection.recipeId });
    }
    const rights = recipePrintRestriction(options.ownerUid, recipe);
    const mayPrintFull = rights.restriction === 'none' || selection.rightsMode === 'rights-confirmed';
    if (rights.restriction !== 'none' && selection.rightsMode === 'original-or-licensed') {
      throw Object.assign(new Error('Confirm print rights or use a source-only page.'), { code: 'RIGHTS_REQUIRED', recipeId: recipe.id });
    }
    if (selection.rightsMode === 'rights-confirmed' && !selection.rightsConfirmedAt) {
      throw Object.assign(new Error('A rights confirmation is missing its timestamp.'), { code: 'RIGHTS_REQUIRED', recipeId: recipe.id });
    }
    return {
      recipeId: recipe.id,
      name: recipe.name,
      description: mayPrintFull ? recipe.description : '',
      ingredients: mayPrintFull ? recipe.ingredients.map(item => ({ name: item.name, quantity: item.quantity })) : [],
      instructions: mayPrintFull ? [...recipe.instructions] : [],
      servings: recipe.servings,
      category: recipe.category,
      // Fridgie may have a display licence for illustrative stock without a
      // licence to put that image on a product for sale. Keep the recipe text
      // printable, but omit that image unless the user explicitly confirms a
      // separate print right.
      photoURL: mayPrintFull
        && selection.photoPlacement !== 'none'
        && (recipe.imageKind !== 'illustrative-stock' || selection.rightsMode === 'rights-confirmed')
        ? recipe.photoURL
        : undefined,
      sourceUrl: recipe.sourceUrl,
      sourceAuthor: recipe.sourceAuthor,
      authorName: recipe.authorName,
      createdBy: recipe.createdBy,
      position,
      section: selection.section || recipe.category || 'Other',
      photoPlacement: selection.photoPlacement,
      rightsMode: selection.rightsMode,
      restriction: rights.restriction,
      notes: selection.notes,
      rightsConfirmedAt: selection.rightsConfirmedAt,
      contentMode: mayPrintFull ? 'full' : 'source-only',
    };
  });
  const base = {
    id: options.id, ownerUid: options.ownerUid, draftId: options.draft.id,
    policyVersion: COOKBOOK_PRINT_POLICY_VERSION, layoutVersion: COOKBOOK_PRINT_LAYOUT_VERSION,
    createdAt: (options.now ?? new Date()).toISOString(),
    title: options.draft.title, subtitle: options.draft.subtitle, dedication: options.draft.dedication,
    byline: options.draft.byline, theme: options.draft.theme, sku: options.draft.sku,
    coverRecipeId: options.draft.coverRecipeId, coverCrop: { ...options.draft.coverCrop },
    includeTableOfContents: options.draft.includeTableOfContents, includeIndex: options.draft.includeIndex,
    recipes,
  };
  return { ...base, contentHash: cookbookPrintHash(base) };
}

function wrap(textValue: string, maxChars: number): string[] {
  const clean = textValue.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const lines: string[] = [];
  let line = '';
  for (const wordValue of clean.split(' ')) {
    const pieces = wordValue.length > maxChars
      ? wordValue.match(new RegExp(`.{1,${maxChars}}`, 'g')) ?? [wordValue]
      : [wordValue];
    for (const word of pieces) {
      if (!line) line = word;
      else if (`${line} ${word}`.length <= maxChars) line += ` ${word}`;
      else { lines.push(line); line = word; }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function formatPageRanges(values: Iterable<number>): string {
  const pages = [...new Set(values)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let index = 0; index < pages.length;) {
    const start = pages[index]!;
    let end = start;
    while (index + 1 < pages.length && pages[index + 1] === end + 1) end = pages[++index]!;
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    index += 1;
  }
  return ranges.join(', ');
}

function wrapIndexReferences(value: string, maxChars = 18): string[] {
  const parts = value.split(', ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    const candidate = line ? `${line}, ${part}` : part;
    if (candidate.length <= maxChars) line = candidate;
    else {
      if (line) lines.push(line);
      line = part;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function textElement(lines: string[], options: Omit<Extract<PrintElement, { kind: 'text' }>, 'kind' | 'lines'>): PrintElement {
  return { kind: 'text', lines, ...options };
}

function pageBase(pageNumber: number, kind: CookbookPrintPagePlan['kind'], label: string, theme: CookbookPrintTheme): CookbookPrintPagePlan {
  const palette = THEMES[theme];
  return { pageNumber, kind, label, elements: [{ kind: 'rect', x: 0, top: 0, width: LAYOUT_WIDTH_PT, height: LAYOUT_HEIGHT_PT, color: palette.paper }] };
}

function addRecipePages(recipe: CookbookPrintSnapshotRecipe, startPage: number, theme: CookbookPrintTheme, issues: CookbookPrintIssue[]): CookbookPrintPagePlan[] {
  const palette = THEMES[theme];
  if (recipe.contentMode === 'source-only') {
    const pages: CookbookPrintPagePlan[] = [];
    const page = pageBase(startPage, 'source', recipe.name, theme);
    page.recipeId = recipe.recipeId;
    page.section = recipe.section;
    pages.push(page);
    page.elements.push(
      { kind: 'rect', x: 48, top: 52, width: 516, height: 78, color: palette.wash },
      textElement(wrap(recipe.name, 32), { x: 66, top: 70, width: 480, fontSize: 24, lineHeight: 30, color: palette.ink, role: 'recipe-title' }),
      textElement(['From the original source'], { x: 66, top: 158, width: 360, fontSize: 12, lineHeight: 16, color: palette.accent, role: 'eyebrow' }),
    );
    let top = 184;
    const credit = recipe.restriction === 'photo-import'
      ? 'Imported from a photographed page'
      : recipe.sourceAuthor || recipe.authorName || 'Original creator';
    page.elements.push(textElement(wrap(credit, 52), { x: 66, top, width: 360, fontSize: 16, lineHeight: 21, color: palette.ink }));
    top += 54;
    if (recipe.sourceUrl) {
      page.elements.push({ kind: 'qr', value: recipe.sourceUrl, x: 414, top: 154, size: 118 });
      page.elements.push(textElement(wrap(recipe.sourceUrl, 48), { x: 66, top, width: 330, fontSize: 8, lineHeight: 11, color: palette.muted }));
      top += 52;
    }
    const noteLines = recipe.notes ? wrap(recipe.notes, 64) : [];
    if (noteLines.length) {
      page.elements.push(textElement(['MY NOTES'], { x: 66, top, width: 460, fontSize: 11, lineHeight: 15, color: palette.accent, role: 'heading' }));
      top += 25;
      const firstCapacity = Math.max(1, Math.floor((724 - top) / 17));
      page.elements.push(textElement(noteLines.slice(0, firstCapacity), { x: 66, top, width: 480, fontSize: 11, lineHeight: 17, color: palette.ink }));
      let offset = firstCapacity;
      while (offset < noteLines.length) {
        const continuationPage = pageBase(startPage + pages.length, 'source', `${recipe.name} - notes continued`, theme);
        continuationPage.recipeId = recipe.recipeId;
        continuationPage.section = recipe.section;
        continuationPage.elements.push(
          textElement(wrap(`${recipe.name} - notes continued`, 42), { x: 58, top: 52, width: 496, fontSize: 16, lineHeight: 21, color: palette.ink, role: 'continuation' }),
          textElement(['MY NOTES'], { x: 58, top: 94, width: 496, fontSize: 11, lineHeight: 15, color: palette.accent, role: 'heading' }),
        );
        const chunk = noteLines.slice(offset, offset + 34);
        continuationPage.elements.push(textElement(chunk, { x: 68, top: 123, width: 476, fontSize: 11, lineHeight: 17, color: palette.ink }));
        offset += chunk.length;
        pages.push(continuationPage);
      }
    } else {
      page.elements.push(textElement(['Add your own notes in the builder to make this page yours.'], { x: 66, top, width: 480, fontSize: 11, lineHeight: 17, color: palette.muted }));
    }
    return pages;
  }

  const pages: CookbookPrintPagePlan[] = [];
  let page = pageBase(startPage, 'recipe', recipe.name, theme);
  page.recipeId = recipe.recipeId;
  page.section = recipe.section;
  pages.push(page);
  let top = 54;

  const continuation = () => {
    page = pageBase(startPage + pages.length, 'recipe', `${recipe.name} - continued`, theme);
    page.recipeId = recipe.recipeId;
    page.section = recipe.section;
    if (theme === 'modern') page.elements.push({ kind: 'rect', x: 0, top: 0, width: 22, height: LAYOUT_HEIGHT_PT, color: palette.accent });
    page.elements.push(textElement(wrap(`${recipe.name} - continued`, 42), { x: 58, top: 52, width: 496, fontSize: 16, lineHeight: 21, color: palette.ink, role: 'continuation' }));
    top = 94;
    pages.push(page);
  };
  const ensure = (height: number) => { if (top + height > 724) continuation(); };

  if (theme === 'modern') page.elements.push({ kind: 'rect', x: 0, top: 0, width: 22, height: LAYOUT_HEIGHT_PT, color: palette.accent });
  const titleSize = theme === 'photo-forward' ? 28 : theme === 'modern' ? 27 : 25;
  const titleLines = wrap(recipe.name, theme === 'photo-forward' ? 29 : 34);
  page.elements.push(textElement(titleLines, { x: 58, top, width: 496, fontSize: titleSize, lineHeight: titleSize + 6, color: palette.ink, align: theme === 'classic' ? 'center' : 'left', role: 'recipe-title' }));
  top += titleLines.length * (titleSize + 6) + 12;
  if (recipe.description) {
    const description = wrap(recipe.description, 68);
    for (const line of description) {
      ensure(15);
      page.elements.push(textElement([line], { x: 68, top, width: 476, fontSize: 10, lineHeight: 15, color: palette.muted, align: theme === 'classic' ? 'center' : 'left' }));
      top += 15;
    }
    top += 14;
  }
  const wantsHero = recipe.photoURL && recipe.photoPlacement !== 'none'
    && (recipe.photoPlacement === 'hero' || (theme === 'photo-forward' && recipe.photoPlacement === 'auto'));
  const interiorCrop = { x: 0.5, y: 0.5, zoom: 1 };
  if (wantsHero && recipe.photoURL) {
    ensure(228);
    page.elements.push({ kind: 'image', recipeId: recipe.recipeId, url: recipe.photoURL, x: 58, top, width: 496, height: 210, crop: interiorCrop, role: 'hero' });
    top += 228;
  } else if (recipe.photoURL && recipe.photoPlacement !== 'none') {
    ensure(140);
    page.elements.push({ kind: 'image', recipeId: recipe.recipeId, url: recipe.photoURL, x: theme === 'classic' ? 186 : 58, top, width: theme === 'classic' ? 240 : 496, height: 122, crop: interiorCrop, role: 'inline' });
    top += 140;
  }
  if (recipe.servings) {
    ensure(24);
    page.elements.push(textElement([`SERVES ${recipe.servings}`], { x: 58, top, width: 496, fontSize: 9, lineHeight: 12, color: palette.accent, role: 'meta' }));
    top += 24;
  }

  const ingredientRows = recipe.ingredients.flatMap(item => wrap(`${item.quantity ? `${item.quantity}  ` : ''}${item.name}`, 60));
  ensure(Math.min(ingredientRows.length, 3) * 15 + 38);
  page.elements.push(textElement(['INGREDIENTS'], { x: 58, top, width: 496, fontSize: 11, lineHeight: 15, color: palette.accent, role: 'heading' }));
  top += 25;
  for (const row of ingredientRows) {
    ensure(17);
    page.elements.push(textElement([row], { x: 68, top, width: 476, fontSize: 10, lineHeight: 15, color: palette.ink }));
    top += 17;
  }
  top += 12;

  ensure(72);
  page.elements.push(textElement(['METHOD'], { x: 58, top, width: 496, fontSize: 11, lineHeight: 15, color: palette.accent, role: 'heading' }));
  top += 27;
  recipe.instructions.forEach((instruction, index) => {
    const lines = wrap(instruction, 61);
    const height = lines.length * 15 + 17;
    if (height > 600) {
      issues.push({ code: 'text-overflow', severity: 'error', message: `One step in ${recipe.name} is too long for a print page.`, recipeId: recipe.recipeId, pageNumber: page.pageNumber });
    }
    ensure(Math.min(height, 600));
    page.elements.push(textElement([`${index + 1}. ${lines[0] ?? ''}`, ...lines.slice(1).map(line => `   ${line}`)], { x: 68, top, width: 476, fontSize: 10, lineHeight: 15, color: palette.ink, role: 'step' }));
    top += height;
  });
  if (recipe.notes) {
    const notes = wrap(recipe.notes, 61);
    ensure(42);
    page.elements.push(textElement(['NOTES'], { x: 58, top, width: 496, fontSize: 11, lineHeight: 15, color: palette.accent, role: 'heading' }));
    top += 24;
    for (const line of notes) {
      ensure(17);
      page.elements.push(textElement([line], { x: 68, top, width: 476, fontSize: 10, lineHeight: 15, color: palette.ink }));
      top += 17;
    }
  }
  return pages;
}

function makeTitlePage(snapshot: CookbookPrintSnapshot, pageNumber: number): CookbookPrintPagePlan {
  const palette = THEMES[snapshot.theme];
  const page = pageBase(pageNumber, 'title', snapshot.title, snapshot.theme);
  const titleLines = wrap(snapshot.title, 24).slice(0, 5);
  const subtitleLines = snapshot.subtitle ? wrap(snapshot.subtitle, 48).slice(0, 4) : [];
  const subtitleTop = Math.max(392, 220 + titleLines.length * 43 + 20);
  const bylineTop = Math.max(558, subtitleTop + subtitleLines.length * 21 + 28);
  page.elements.push(
    { kind: 'rect', x: 42, top: 42, width: 528, height: 708, color: palette.wash },
    textElement(titleLines, { x: 76, top: 220, width: 460, fontSize: 34, lineHeight: 43, color: palette.ink, align: 'center', role: 'book-title' }),
  );
  if (subtitleLines.length) page.elements.push(textElement(subtitleLines, { x: 92, top: subtitleTop, width: 428, fontSize: 14, lineHeight: 21, color: palette.muted, align: 'center' }));
  page.elements.push(textElement(wrap(snapshot.byline, 52).slice(0, 2), { x: 92, top: bylineTop, width: 428, fontSize: 12, lineHeight: 18, color: palette.accent, align: 'center', role: 'byline' }));
  return page;
}

function makeDedicationPage(snapshot: CookbookPrintSnapshot, pageNumber: number): CookbookPrintPagePlan {
  const palette = THEMES[snapshot.theme];
  const page = pageBase(pageNumber, 'dedication', 'Dedication', snapshot.theme);
  const copy = snapshot.dedication || 'Made with Fridgie - a collection to cook from, write in, and pass around.';
  const lines = wrap(copy, 54).slice(0, 22);
  const dedicationTop = Math.max(130, 365 - lines.length * 11.5);
  page.elements.push(textElement(lines, { x: 96, top: dedicationTop, width: 420, fontSize: 14, lineHeight: 23, color: palette.ink, align: 'center', role: 'dedication' }));
  page.elements.push(textElement(wrap(`Printed for ${snapshot.byline}`, 58).slice(0, 2), { x: 96, top: 680, width: 420, fontSize: 9, lineHeight: 14, color: palette.muted, align: 'center' }));
  return page;
}

function makeSectionPage(section: string, pageNumber: number, theme: CookbookPrintTheme): CookbookPrintPagePlan {
  const palette = THEMES[theme];
  const page = pageBase(pageNumber, 'section', section, theme);
  page.section = section;
  page.elements.push({ kind: 'rect', x: 42, top: 42, width: 528, height: 708, color: palette.wash });
  page.elements.push(textElement(wrap(section, 24), { x: 76, top: 326, width: 460, fontSize: 31, lineHeight: 40, color: palette.ink, align: 'center', role: 'section-title' }));
  return page;
}

export function layoutCookbook(snapshot: CookbookPrintSnapshot, options: { spineWidthInches?: number; minPages?: number } = {}): CookbookPrintLayoutPlan {
  const issues: CookbookPrintIssue[] = [];
  const tocPages = snapshot.includeTableOfContents ? Math.max(1, Math.ceil(snapshot.recipes.length / 18)) : 0;
  const frontCount = 2 + tocPages;
  const body: CookbookPrintPagePlan[] = [];
  const recipePage = new Map<string, number>();
  let currentSection = '';
  let nextPage = frontCount + 1;
  for (const recipe of snapshot.recipes) {
    if (recipe.section !== currentSection) {
      currentSection = recipe.section;
      body.push(makeSectionPage(currentSection, nextPage++, snapshot.theme));
    }
    const pages = addRecipePages(recipe, nextPage, snapshot.theme, issues);
    recipePage.set(recipe.recipeId, nextPage);
    body.push(...pages);
    nextPage += pages.length;
  }

  const front = [makeTitlePage(snapshot, 1), makeDedicationPage(snapshot, 2)];
  if (snapshot.includeTableOfContents) {
    const palette = THEMES[snapshot.theme];
    for (let index = 0; index < tocPages; index += 1) {
      const page = pageBase(3 + index, 'contents', index ? 'Contents - continued' : 'Contents', snapshot.theme);
      page.elements.push(textElement([index ? 'CONTENTS - CONTINUED' : 'CONTENTS'], { x: 58, top: 62, width: 496, fontSize: 19, lineHeight: 25, color: palette.ink, role: 'heading' }));
      snapshot.recipes.slice(index * 18, (index + 1) * 18).forEach((recipe, row) => {
        const target = recipePage.get(recipe.recipeId) ?? 0;
        page.elements.push(textElement(wrap(recipe.name, 55).slice(0, 2), { x: 66, top: 112 + row * 31, width: 400, fontSize: 10, lineHeight: 14, color: palette.ink }));
        page.elements.push(textElement([String(target)], { x: 486, top: 112 + row * 31, width: 52, fontSize: 10, lineHeight: 15, color: palette.accent, align: 'right' }));
        page.elements.push({ kind: 'rule', x: 66, top: 132 + row * 31, width: 472, color: palette.wash, thickness: 1 });
      });
      front.push(page);
    }
  }

  const indexPages: CookbookPrintPagePlan[] = [];
  if (snapshot.includeIndex) {
    const names = new Map<string, Set<number>>();
    for (const recipe of snapshot.recipes) {
      const pageNumber = recipePage.get(recipe.recipeId)!;
      const titlePages = names.get(recipe.name) ?? new Set<number>();
      titlePages.add(pageNumber);
      names.set(recipe.name, titlePages);
      for (const ingredient of recipe.ingredients) {
        const key = ingredient.name.replace(/,.*$/, '').trim();
        if (!key) continue;
        const pages = names.get(key) ?? new Set<number>();
        pages.add(pageNumber);
        names.set(key, pages);
      }
    }
    // Never silently truncate the index. If a very large cookbook pushes the
    // complete index beyond the provider page limit, the normal page-count
    // preflight blocks checkout and tells the user to shorten the book.
    const entries = [...names.entries()].sort(([a], [b]) => a.localeCompare(b));
    const palette = THEMES[snapshot.theme];
    let page: CookbookPrintPagePlan | undefined;
    let top = 104;
    const newIndexPage = () => {
      page = pageBase(nextPage++, 'index', indexPages.length ? 'Index - continued' : 'Index', snapshot.theme);
      page.elements.push(textElement([indexPages.length ? 'INDEX - CONTINUED' : 'INDEX'], { x: 58, top: 56, width: 496, fontSize: 19, lineHeight: 25, color: palette.ink, role: 'heading' }));
      indexPages.push(page);
      top = 104;
    };
    newIndexPage();
    for (const [label, pages] of entries) {
      const labelLines = wrap(label, 45);
      const referenceLines = wrapIndexReferences(formatPageRanges(pages));
      const lineCount = Math.max(1, labelLines.length, referenceLines.length);
      const rowHeight = lineCount * 13 + 11;
      if (top + rowHeight > 710) newIndexPage();
      page!.elements.push(textElement(labelLines, { x: 58, top, width: 350, fontSize: 9, lineHeight: 13, color: palette.ink }));
      page!.elements.push(textElement(referenceLines, { x: 420, top, width: 118, fontSize: 9, lineHeight: 13, color: palette.accent, align: 'right' }));
      top += rowHeight;
    }
  }

  const pages = [...front, ...body, ...indexPages];
  const minimum = options.minPages ?? COOKBOOK_PRINT_MIN_PAGES;
  const palette = THEMES[snapshot.theme];
  // Lulu may add blank leaves itself. Padding deliberately to a multiple of
  // four keeps the frozen page count, cover geometry and delivered book equal.
  while (pages.length < minimum || pages.length % 4 !== 0) {
    const pageNumber = pages.length + 1;
    const page = pageBase(pageNumber, 'notes', 'Notes', snapshot.theme);
    page.elements.push(textElement(['NOTES'], { x: 58, top: 58, width: 496, fontSize: 18, lineHeight: 24, color: palette.ink, role: 'heading' }));
    for (let row = 0; row < 21; row += 1) page.elements.push({ kind: 'rule', x: 58, top: 116 + row * 28, width: 496, color: palette.wash, thickness: 1 });
    pages.push(page);
  }
  if (pages.length > COOKBOOK_PRINT_MAX_PAGES) issues.push({ code: 'page-count', severity: 'error', message: `This book has ${pages.length} pages; the maximum supported length is ${COOKBOOK_PRINT_MAX_PAGES}.` });
  const coverRecipe = snapshot.recipes.find(recipe => recipe.recipeId === snapshot.coverRecipeId);
  if (!coverRecipe?.photoURL) issues.push({ code: 'missing-image', severity: 'warning', message: 'No printable cover photo is selected; the cover will use a typographic design.', recipeId: snapshot.coverRecipeId });
  if (snapshot.theme === 'photo-forward') {
    for (const recipe of snapshot.recipes.filter(recipe => recipe.contentMode === 'full' && !recipe.photoURL)) {
      issues.push({ code: 'missing-image', severity: 'warning', message: `${recipe.name} has no photo; its page will use a typographic layout.`, recipeId: recipe.recipeId, pageNumber: recipePage.get(recipe.recipeId) });
    }
  }
  for (const page of pages) {
    if (!page.elements.some(element => element.kind !== 'rect' && (element.kind !== 'text' || element.lines.some(Boolean)))) {
      issues.push({ code: 'empty-page', severity: 'error', message: `Page ${page.pageNumber} is empty.`, pageNumber: page.pageNumber });
    }
  }
  const spineWidthInches = options.spineWidthInches ?? (
    snapshot.sku === 'matte-softcover'
      ? pages.length / 444 + 0.06
      : pages.length <= 84 ? 0.25
        : pages.length <= 140 ? 0.5
          : pages.length <= 168 ? 0.625
            : pages.length <= 194 ? 0.6875
              : pages.length <= 222 ? 0.75
                : pages.length <= 250 ? 0.8125
                  : pages.length <= 278 ? 0.875
                    : pages.length <= 306 ? 0.9375
                      : pages.length <= 334 ? 1
                        : pages.length <= 362 ? 1.0625
                          : pages.length <= 390 ? 1.125
                            : pages.length <= 418 ? 1.1875
                              : pages.length <= 446 ? 1.25
                                : pages.length <= 474 ? 1.3125
                                  : pages.length <= 502 ? 1.375
                                    : pages.length <= 530 ? 1.4375
                                      : pages.length <= 558 ? 1.5
                                        : pages.length <= 586 ? 1.5625
                                          : pages.length <= 614 ? 1.625
                                            : pages.length <= 642 ? 1.6875
                                              : pages.length <= 670 ? 1.75
                                                : pages.length <= 698 ? 1.8125
                                                  : pages.length <= 726 ? 1.875
                                                    : pages.length <= 754 ? 1.9375
                                                      : 2
  );
  if (spineWidthInches < 0.0625) issues.push({ code: 'spine-width', severity: 'warning', message: 'The spine is too narrow for readable spine text.' });
  return { width: INTERIOR_WIDTH_PT, height: INTERIOR_HEIGHT_PT, theme: snapshot.theme, pages, spineWidthInches, issues };
}

export function quoteExpired(quote: CookbookPrintQuote, now = new Date()): boolean {
  return !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= now.getTime();
}

export function quoteBinding(quote: Pick<CookbookPrintQuote, 'draftId' | 'sku' | 'total' | 'shippingMethod' | 'expiresAt'>, addressHash: string, snapshotHash: string): string {
  return cookbookPrintHash({ draftId: quote.draftId, sku: quote.sku, total: quote.total, shippingMethod: quote.shippingMethod, expiresAt: quote.expiresAt, addressHash, snapshotHash });
}

const FULFILLMENT_TRANSITIONS: Record<CookbookPrintFulfillmentStatus, ReadonlySet<CookbookPrintFulfillmentStatus>> = {
  'awaiting-payment': new Set(['submitting', 'cancelled', 'failed']),
  submitting: new Set(['submitted', 'in-production', 'shipped', 'delivered', 'submission-failed', 'submission-unknown', 'cancelled', 'failed']),
  'submission-failed': new Set(['submitting', 'submitted', 'in-production', 'shipped', 'delivered', 'cancelled', 'reprint-requested', 'failed']),
  'submission-unknown': new Set(['submitting', 'submitted', 'in-production', 'shipped', 'delivered', 'submission-failed', 'cancelled', 'failed']),
  submitted: new Set(['in-production', 'shipped', 'delivered', 'cancelled', 'failed']),
  'in-production': new Set(['shipped', 'delivered', 'cancelled', 'failed', 'reprint-requested']),
  shipped: new Set(['delivered', 'failed', 'reprint-requested']),
  delivered: new Set(['reprint-requested']),
  cancelled: new Set(),
  'reprint-requested': new Set(['reprinting', 'cancelled']),
  reprinting: new Set(['reprint-requested', 'in-production', 'shipped', 'delivered', 'failed']),
  failed: new Set(['awaiting-payment', 'reprint-requested']),
};

const PAYMENT_TRANSITIONS: Record<CookbookPrintPaymentStatus, ReadonlySet<CookbookPrintPaymentStatus>> = {
  'requires-payment': new Set(['processing', 'paid', 'refund-pending', 'refunded', 'failed']),
  processing: new Set(['paid', 'refund-pending', 'refunded', 'failed']),
  paid: new Set(['refund-pending', 'refunded']),
  'refund-pending': new Set(['refunded', 'paid', 'failed']),
  // A card refund can be reported as succeeded and later fail. Stripe Tax's
  // PaymentIntent integration counter-reverses its tax transaction in that
  // case, and the local payment state must return to paid as well.
  refunded: new Set(['paid']),
  failed: new Set(['requires-payment']),
};

export function canTransitionFulfillment(from: CookbookPrintFulfillmentStatus, to: CookbookPrintFulfillmentStatus): boolean {
  return from === to || FULFILLMENT_TRANSITIONS[from].has(to);
}

export function canTransitionPayment(from: CookbookPrintPaymentStatus, to: CookbookPrintPaymentStatus): boolean {
  return from === to || PAYMENT_TRANSITIONS[from].has(to);
}

export function assertPrintOwner(ownerUid: string, callerUid: string): void {
  if (!ownerUid || ownerUid !== callerUid) throw Object.assign(new Error('Not found.'), { code: 'NOT_FOUND', status: 404 });
}
