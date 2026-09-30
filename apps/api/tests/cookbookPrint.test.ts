import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import type {
  CookbookPrintDraft,
  CookbookPrintFulfillmentStatus,
  CookbookPrintPaymentStatus,
  CookbookPrintQuote,
  CookbookPrintRecipeSelection,
  CookbookPrintTheme,
  Recipe,
} from '@fridgie/shared/types';
import {
  INTERIOR_HEIGHT_PT,
  INTERIOR_WIDTH_PT,
  assertPrintOwner,
  canTransitionFulfillment,
  canTransitionPayment,
  cookbookPrintFeatureAvailable,
  createCookbookPrintSnapshot,
  defaultDraftInput,
  layoutCookbook,
  printableCookbook,
  quoteBinding,
  quoteExpired,
  sanitizeDraftInput,
  type CookbookPrintLayoutPlan,
  type CookbookPrintSnapshot,
} from '../utils/cookbookPrint';
import {
  planCoverTypography,
  renderCookbookPdfs,
  type CoverGeometry,
  type CoverTypographyLine,
} from '../utils/cookbookPrintPdf';

const NOW = '2026-09-29T15:00:00.000Z';

describe('cookbook print launch gate', () => {
  test('stays unavailable unless the validated runtime explicitly enables it', () => {
    expect(cookbookPrintFeatureAvailable({} as NodeJS.ProcessEnv)).toBe(false);
    expect(cookbookPrintFeatureAvailable({ PRINT_COMMERCE_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(cookbookPrintFeatureAvailable({ PRINT_COMMERCE_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

function recipe(id: string, overrides: Partial<Recipe> = {}): Recipe {
  return {
    id,
    name: `Recipe ${id}`,
    description: `A useful description for recipe ${id}.`,
    ingredients: [
      { name: 'chickpeas', quantity: '1 can' },
      { name: 'lemon juice', quantity: '2 tbsp' },
    ],
    instructions: [
      'Drain the chickpeas and put them in a large bowl.',
      'Add the lemon juice, toss well, and serve.',
    ],
    category: 'Mains',
    createdBy: 'owner',
    visibility: 'private',
    ...overrides,
  };
}

function selection(recipeId: string, position: number, overrides: Partial<CookbookPrintRecipeSelection> = {}): CookbookPrintRecipeSelection {
  return {
    recipeId,
    included: true,
    position,
    section: 'Weeknight favourites',
    photoPlacement: 'none',
    rightsMode: 'original-or-licensed',
    ...overrides,
  };
}

function draft(theme: CookbookPrintTheme, recipes: CookbookPrintRecipeSelection[]): CookbookPrintDraft {
  return {
    id: `draft-${theme}`,
    revision: 3,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    title: 'Kitchen Keepsakes',
    subtitle: 'The recipes we return to',
    dedication: 'For everyone who pulls up a chair.',
    byline: 'Ada Cook',
    theme,
    sku: 'matte-softcover',
    coverCrop: { x: 0.5, y: 0.5, zoom: 1 },
    includeTableOfContents: true,
    includeIndex: true,
    recipes,
  };
}

function snapshotFor(theme: CookbookPrintTheme, recipes = [recipe('one')], selections = recipes.map((item, index) => selection(item.id, index))): CookbookPrintSnapshot {
  return createCookbookPrintSnapshot({
    id: `snapshot-${theme}`,
    ownerUid: 'owner',
    draft: draft(theme, selections),
    recipes,
    now: new Date(NOW),
  });
}

function firstRecipePage(plan: CookbookPrintLayoutPlan) {
  const page = plan.pages.find(item => item.kind === 'recipe' && item.label === 'Recipe one');
  if (!page) throw new Error('recipe page missing');
  return page;
}

function hasEmbeddedFont(document: PDFDocument): boolean {
  return document.context.enumerateIndirectObjects().some(([, object]) =>
    object instanceof PDFDict && (
      object.has(PDFName.of('FontFile'))
      || object.has(PDFName.of('FontFile2'))
      || object.has(PDFName.of('FontFile3'))
    ));
}

const COVER_GEOMETRY: CoverGeometry = {
  pageWidthPt: 1_038,
  pageHeightPt: 738,
  backXPt: 9,
  backWidthPt: 504,
  spineXPt: 513,
  spineWidthPt: 12,
  frontXPt: 525,
  frontWidthPt: 504,
  trimTopPt: 9,
  trimHeightPt: 720,
  safeInsetPt: 36,
  providerVerified: true,
};

const proportionalCoverFont = {
  widthOfTextAtSize(value: string, size: number) {
    return Array.from(value).reduce((width, glyph) => {
      if (glyph === 'W' || glyph === 'M') return width + size * 0.9;
      if (glyph === 'i' || glyph === 'l') return width + size * 0.28;
      if (glyph === ' ') return width + size * 0.32;
      return width + size * 0.58;
    }, 0);
  },
};

function textBounds(lines: CoverTypographyLine[]) {
  return {
    top: Math.max(...lines.map(line => line.y + line.size)),
    bottom: Math.min(...lines.map(line => line.y)),
  };
}

describe('cookbook print draft persistence', () => {
  test('uses a natural fallback title when the account has no display name', () => {
    expect(defaultDraftInput('', []).title).toBe('My Cookbook');
    expect(defaultDraftInput('Ada', []).title).toBe("Ada's Cookbook");
  });

  test('sanitizes selection, ordering and removal without losing a restorable row', () => {
    const initial = sanitizeDraftInput({
      title: '  Family table  ',
      byline: '  Ada  ',
      theme: 'modern',
      sku: 'matte-softcover',
      coverCrop: { x: -4, y: 8, zoom: 9 },
      recipes: [
        { recipeId: 'removed', included: false, position: 20, section: ' Supper ', photoPlacement: 'inline', rightsMode: 'original-or-licensed' },
        { recipeId: 'first', included: true, position: 2, photoPlacement: 'auto', rightsMode: 'original-or-licensed' },
        { recipeId: 'first', included: true, position: 0, photoPlacement: 'hero', rightsMode: 'rights-confirmed' },
        { recipeId: 'unknown', included: true, position: 1 },
        { recipeId: 'middle', included: true, position: 7, photoPlacement: 'none', rightsMode: 'source-only', notes: ' My own note. ' },
      ],
    }, new Set(['first', 'middle', 'removed']));

    expect(initial.title).toBe('Family table');
    expect(initial.byline).toBe('Ada');
    expect(initial.coverCrop).toEqual({ x: 0, y: 1, zoom: 3 });
    expect(initial.recipes.map(item => [item.recipeId, item.position, item.included])).toEqual([
      ['first', 0, true],
      ['middle', 1, true],
      ['removed', 2, false],
    ]);
    expect(initial.recipes[1]?.notes).toBe('My own note.');

    const restored = sanitizeDraftInput({
      ...initial,
      recipes: initial.recipes.map(item => item.recipeId === 'removed' ? { ...item, included: true } : item),
    }, new Set(['first', 'middle', 'removed']));
    expect(restored.recipes.map(item => [item.recipeId, item.position, item.included])).toEqual([
      ['first', 0, true],
      ['middle', 1, true],
      ['removed', 2, true],
    ]);

    const reordered = sanitizeDraftInput({
      ...restored,
      recipes: restored.recipes.map(item => ({
        ...item,
        position: item.recipeId === 'removed' ? 0 : item.position + 1,
      })),
    });
    expect(reordered.recipes.map(item => item.recipeId)).toEqual(['removed', 'first', 'middle']);
    expect(reordered.recipes.map(item => item.position)).toEqual([0, 1, 2]);
  });
});

describe('cookbook print rights and immutable snapshots', () => {
  test('filters foreign private recipes and classifies external and contributor content conservatively', () => {
    const own = recipe('own');
    const external = recipe('external', {
      createdBy: 'owner',
      visibility: 'public',
      sourceUrl: 'https://example.com/recipes/lemon-chickpeas',
      sourceAuthor: 'Example Cook',
      photoURL: 'https://example.com/photo.jpg',
    });
    const contributor = recipe('contributor', { createdBy: 'family-member', visibility: 'public' });
    const photographed = recipe('photographed', { contentOrigin: 'photo-imported', visibility: 'private' });
    const inaccessible = recipe('private-other', { createdBy: 'stranger', visibility: 'private' });

    const printable = printableCookbook('owner', [own, external, contributor, photographed, inaccessible]);
    expect(printable.map(item => item.id)).toEqual(['own', 'external', 'contributor', 'photographed']);
    expect(printable.map(item => [item.id, item.printRestriction, item.defaultRightsMode, item.photoPrintAllowedByDefault])).toEqual([
      ['own', 'none', 'original-or-licensed', true],
      ['external', 'external-source', 'source-only', false],
      ['contributor', 'contributor-permission', 'source-only', false],
      ['photographed', 'photo-import', 'source-only', false],
    ]);
  });

  test('source-only snapshots omit copied directions and images but retain attribution and user notes', () => {
    const imported = recipe('imported', {
      visibility: 'public',
      sourceUrl: 'https://example.com/recipe',
      sourceAuthor: 'Original Cook',
      photoURL: 'https://example.com/source-photo.jpg',
    });
    const sourceSelection = selection(imported.id, 0, {
      rightsMode: 'source-only',
      notes: 'I serve this with extra lemon.',
      photoPlacement: 'hero',
    });
    const snapshot = snapshotFor('classic', [imported], [sourceSelection]);
    const frozen = snapshot.recipes[0]!;

    expect(frozen.contentMode).toBe('source-only');
    expect(frozen.description).toBe('');
    expect(frozen.ingredients).toEqual([]);
    expect(frozen.instructions).toEqual([]);
    expect(frozen.photoURL).toBeUndefined();
    expect(frozen.sourceUrl).toBe(imported.sourceUrl);
    expect(frozen.sourceAuthor).toBe('Original Cook');
    expect(frozen.notes).toBe('I serve this with extra lemon.');
  });

  test('restricted full content requires a timestamped rights confirmation', () => {
    const contributor = recipe('shared', { createdBy: 'family-member', visibility: 'public' });
    const make = (rightsMode: CookbookPrintRecipeSelection['rightsMode'], rightsConfirmedAt?: string) => () => snapshotFor(
      'classic',
      [contributor],
      [selection(contributor.id, 0, { rightsMode, rightsConfirmedAt })],
    );

    for (const attempt of [make('original-or-licensed'), make('rights-confirmed')]) {
      try {
        attempt();
        throw new Error('expected rights validation to fail');
      } catch (error: any) {
        expect(error.code).toBe('RIGHTS_REQUIRED');
        expect(error.recipeId).toBe('shared');
      }
    }

    const confirmed = make('rights-confirmed', NOW)();
    expect(confirmed.recipes[0]).toMatchObject({
      contentMode: 'full',
      restriction: 'contributor-permission',
      rightsConfirmedAt: NOW,
    });
    expect(confirmed.recipes[0]?.ingredients).toHaveLength(2);
  });

  test('never carries default-disallowed stock art into a product snapshot', () => {
    const curated = recipe('curated', {
      visibility: 'public',
      createdBy: 'curated-kitchen',
      contentOrigin: 'ai-curated',
      imageKind: 'illustrative-stock',
      photoURL: 'https://images.example.test/licensed-for-display-only.jpg',
    });
    const snapshot = snapshotFor('classic', [curated], [selection(curated.id, 0, { photoPlacement: 'hero' })]);
    expect(snapshot.recipes[0]?.contentMode).toBe('full');
    expect(snapshot.recipes[0]?.photoURL).toBeUndefined();
  });

  test('copies recipe and draft data into an immutable content-addressed snapshot', () => {
    const sourceRecipe = recipe('frozen');
    const sourceDraft = draft('classic', [selection(sourceRecipe.id, 0)]);
    const snapshot = createCookbookPrintSnapshot({
      id: 'immutable-snapshot',
      ownerUid: 'owner',
      draft: sourceDraft,
      recipes: [sourceRecipe],
      now: new Date(NOW),
    });
    const originalHash = snapshot.contentHash;

    sourceRecipe.name = 'Changed after checkout';
    sourceRecipe.ingredients[0]!.name = 'changed ingredient';
    sourceRecipe.instructions[0] = 'Changed step.';
    sourceDraft.title = 'Changed book';
    sourceDraft.coverCrop.x = 0;

    expect(snapshot.title).toBe('Kitchen Keepsakes');
    expect(snapshot.coverCrop.x).toBe(0.5);
    expect(snapshot.recipes[0]?.name).toBe('Recipe frozen');
    expect(snapshot.recipes[0]?.ingredients[0]?.name).toBe('chickpeas');
    expect(snapshot.recipes[0]?.instructions[0]).toStartWith('Drain the chickpeas');
    expect(snapshot.contentHash).toBe(originalHash);

    const changedSnapshot = createCookbookPrintSnapshot({
      id: 'changed-snapshot',
      ownerUid: 'owner',
      draft: sourceDraft,
      recipes: [sourceRecipe],
      now: new Date(NOW),
    });
    expect(changedSnapshot.contentHash).not.toBe(originalHash);
  });
});

describe('cookbook pagination and preflight', () => {
  test('pads to the provider minimum and a multiple of four without empty pages', () => {
    const plan = layoutCookbook(snapshotFor('classic'));
    expect(plan.pages.length).toBeGreaterThanOrEqual(32);
    expect(plan.pages.length % 4).toBe(0);
    expect(plan.pages.map(page => page.pageNumber)).toEqual(Array.from({ length: plan.pages.length }, (_, index) => index + 1));
    expect(plan.issues.filter(issue => issue.code === 'empty-page')).toEqual([]);
    for (const page of plan.pages) {
      expect(page.elements.some(element => element.kind !== 'rect' && (element.kind !== 'text' || element.lines.some(Boolean)))).toBe(true);
    }
  });

  test('moves ordinary method steps as whole blocks and flags an individually unprintable long step', () => {
    const manySteps = recipe('one', {
      ingredients: Array.from({ length: 22 }, (_, index) => ({ name: `ingredient ${index}`, quantity: `${index + 1} tbsp` })),
      instructions: Array.from({ length: 14 }, (_, index) => `Step ${index + 1} has enough detail to occupy several words without being split inside its text block.`),
    });
    const ordinary = layoutCookbook(snapshotFor('modern', [manySteps]));
    const stepElements = ordinary.pages.flatMap(page => page.elements
      .filter((element): element is Extract<typeof element, { kind: 'text' }> => element.kind === 'text' && element.role === 'step')
      .map(element => ({ page: page.pageNumber, lines: element.lines })));
    expect(stepElements).toHaveLength(manySteps.instructions.length);
    expect(stepElements.every(element => element.lines.length > 0 && /^\d+\./.test(element.lines[0]!))).toBe(true);
    expect(ordinary.issues.some(issue => issue.code === 'orphaned-block')).toBe(false);

    const long = recipe('one', { instructions: [`Explain every motion ${'with extraordinary detail '.repeat(900)}`] });
    const overflow = layoutCookbook(snapshotFor('classic', [long]));
    expect(overflow.issues).toContainEqual(expect.objectContaining({
      code: 'text-overflow',
      severity: 'error',
      recipeId: 'one',
    }));
  });

  test('paginates long notes inside the safe content area and preserves Modern continuation chrome', () => {
    const detailed = recipe('one', {
      ingredients: Array.from({ length: 24 }, (_, index) => ({ name: `ingredient ${index}`, quantity: `${index + 1} tbsp` })),
      instructions: Array.from({ length: 12 }, (_, index) => `Step ${index + 1} contains a few clear words for the cook.`),
    });
    const notes = `${'A handwritten variation with useful detail. '.repeat(45)} ENDMARKER`;
    const plan = layoutCookbook(snapshotFor('modern', [detailed], [selection('one', 0, { notes })]));
    const recipePages = plan.pages.filter(page => page.kind === 'recipe' && page.recipeId === 'one');
    expect(recipePages.length).toBeGreaterThan(1);
    for (const page of recipePages) {
      expect(page.elements).toContainEqual(expect.objectContaining({ kind: 'rect', x: 0, width: 22, color: '#23785E' }));
      for (const element of page.elements) {
        if (element.kind === 'text') expect(element.top + element.lines.length * element.lineHeight).toBeLessThanOrEqual(742);
      }
    }
    expect(recipePages.flatMap(page => page.elements).some(element => element.kind === 'text' && element.lines.some(line => line.includes('ENDMARKER')))).toBe(true);
  });

  test('paginates the complete recipe description instead of truncating it', () => {
    const description = `${'A detailed family story that belongs beside this recipe. '.repeat(150)} DESCRIPTION-END`;
    const plan = layoutCookbook(snapshotFor('classic', [recipe('one', { description })]));
    const recipePages = plan.pages.filter(page => page.kind === 'recipe' && page.recipeId === 'one');
    expect(recipePages.length).toBeGreaterThan(1);
    expect(recipePages.flatMap(page => page.elements).some(element =>
      element.kind === 'text' && element.lines.some(line => line.includes('DESCRIPTION-END')))).toBe(true);
    for (const page of recipePages) {
      for (const element of page.elements) {
        if (element.kind === 'text') expect(element.top + element.lines.length * element.lineHeight).toBeLessThanOrEqual(742);
      }
    }
  });

  test('keeps a complete readable index with compressed and wrapped page references', () => {
    const recipes = Array.from({ length: 48 }, (_, index) => recipe(`index-${String(index + 1).padStart(2, '0')}`, {
      name: `Family recipe ${String(index + 1).padStart(2, '0')}`,
      description: '',
      ingredients: [{ name: 'shared pantry staple', quantity: '1 cup' }],
      instructions: ['Mix and serve.'],
    }));
    const plan = layoutCookbook(snapshotFor('modern', recipes));
    const indexPages = plan.pages.filter(page => page.kind === 'index');
    expect(indexPages.length).toBeGreaterThan(1);
    const referenceElements = indexPages.flatMap(page => page.elements).filter(element => element.kind === 'text' && element.x === 420);
    expect(referenceElements.length).toBeGreaterThan(0);
    expect(referenceElements.flatMap(element => element.kind === 'text' ? element.lines : []).every(line => line.length <= 18)).toBe(true);
    const sharedReference = referenceElements.find(element => element.kind === 'text'
      && element.lines.some(line => line.includes('-')));
    expect(sharedReference).toBeDefined();
  });

  test('combines page references for duplicate recipe and ingredient index labels', () => {
    const recipes = [
      recipe('duplicate-a', { name: 'Family Pie', ingredients: [{ name: 'Family Pie', quantity: '1' }] }),
      recipe('duplicate-b', { name: 'Family Pie', ingredients: [{ name: 'Family Pie', quantity: '2' }] }),
    ];
    const plan = layoutCookbook(snapshotFor('classic', recipes));
    const index = plan.pages.filter(page => page.kind === 'index').flatMap(page => page.elements);
    const labels = index.filter(element => element.kind === 'text' && element.x === 58
      && element.lines.join(' ') === 'Family Pie');
    expect(labels).toHaveLength(1);
    const reference = index.find(element => element.kind === 'text' && element.x === 420
      && element.top === labels[0]!.top);
    expect(reference).toMatchObject({ kind: 'text', lines: [expect.stringContaining('-')] });
  });

  test('honours explicit inline placement and keeps cover crop off interior photos', () => {
    const pictured = recipe('one', { photoURL: 'https://images.example.test/dish.jpg' });
    const sourceDraft = draft('photo-forward', [selection('one', 0, { photoPlacement: 'inline' })]);
    sourceDraft.coverRecipeId = 'one';
    sourceDraft.coverCrop = { x: 0.1, y: 0.9, zoom: 2.5 };
    const snapshot = createCookbookPrintSnapshot({ id: 'placement', ownerUid: 'owner', draft: sourceDraft, recipes: [pictured], now: new Date(NOW) });
    const image = layoutCookbook(snapshot).pages.flatMap(page => page.elements).find(element => element.kind === 'image' && element.recipeId === 'one');
    expect(image).toMatchObject({ kind: 'image', role: 'inline', crop: { x: 0.5, y: 0.5, zoom: 1 } });
  });
});

describe('theme fidelity in generated PDFs', () => {
  test('classic, modern and photo-forward produce different plans and embedded print artifacts', async () => {
    const themes: CookbookPrintTheme[] = ['classic', 'modern', 'photo-forward'];
    const rendered = await Promise.all(themes.map(async theme => {
      const snapshot = snapshotFor(theme);
      const plan = layoutCookbook(snapshot);
      const artifacts = await renderCookbookPdfs(snapshot, plan);
      const document = await PDFDocument.load(artifacts.interior);
      return { theme, snapshot, plan, artifacts, document };
    }));

    const [classic, modern, photoForward] = rendered;
    const classicTitle = firstRecipePage(classic!.plan).elements.find(element => element.kind === 'text' && element.role === 'recipe-title');
    const modernPage = firstRecipePage(modern!.plan);
    const modernTitle = modernPage.elements.find(element => element.kind === 'text' && element.role === 'recipe-title');
    const photoTitle = firstRecipePage(photoForward!.plan).elements.find(element => element.kind === 'text' && element.role === 'recipe-title');
    expect(classicTitle).toMatchObject({ kind: 'text', align: 'center', fontSize: 25 });
    expect(modernTitle).toMatchObject({ kind: 'text', align: 'left', fontSize: 27 });
    expect(modernPage.elements).toContainEqual(expect.objectContaining({ kind: 'rect', x: 0, width: 22, color: '#23785E' }));
    expect(photoTitle).toMatchObject({ kind: 'text', align: 'left', fontSize: 28 });

    expect(new Set(rendered.map(item => item.artifacts.interiorSha256)).size).toBe(3);
    expect(new Set(rendered.map(item => item.artifacts.coverSha256)).size).toBe(3);
    const repeatedClassic = await renderCookbookPdfs(classic!.snapshot, classic!.plan);
    expect(repeatedClassic.interiorSha256).toBe(classic!.artifacts.interiorSha256);
    expect(repeatedClassic.coverSha256).toBe(classic!.artifacts.coverSha256);
    for (const item of rendered) {
      expect(item.document.getPageCount()).toBe(item.plan.pages.length);
      expect(item.document.getPageCount() % 4).toBe(0);
      expect(item.document.getTitle()).toBe('Kitchen Keepsakes');
      expect(item.document.getAuthor()).toBe('Ada Cook');
      expect(item.document.getSubject()).toBe('Personal printed cookbook');
      expect(item.document.getCreator()).toContain('Fridgie cookbook renderer');
      expect(item.document.getPage(0).getSize().width).toBeCloseTo(INTERIOR_WIDTH_PT, 4);
      expect(item.document.getPage(0).getSize().height).toBeCloseTo(INTERIOR_HEIGHT_PT, 4);
      expect(hasEmbeddedFont(item.document)).toBe(true);
      expect(item.artifacts.interiorSha256).toBe(createHash('sha256').update(item.artifacts.interior).digest('hex'));
      expect(item.artifacts.coverSha256).toBe(createHash('sha256').update(item.artifacts.cover).digest('hex'));
      expect(item.artifacts.issues.some(issue => issue.code === 'missing-image' && issue.severity === 'error')).toBe(false);
    }
  }, 60_000);
});

describe('cover typography', () => {
  test('uses measured widths and hard-splits an unbroken title without dropping copy', () => {
    const title = 'W'.repeat(120);
    const typography = planCoverTypography({
      title,
      byline: 'Ada Cook',
      geometry: COVER_GEOMETRY,
      font: proportionalCoverFont,
    });

    expect(typography.title.length).toBeGreaterThan(4);
    expect(typography.title.map(line => line.text).join('')).toBe(title);
    for (const line of typography.title) {
      expect(line.width).toBeLessThanOrEqual(typography.safeBox.width);
      expect(proportionalCoverFont.widthOfTextAtSize(line.text, line.size)).toBe(line.width);
    }
  });

  test('stacks maximum-length title, subtitle and byline inside the front safe box without overlap', async () => {
    const title = 'W'.repeat(120);
    const subtitle = 'M'.repeat(180);
    const byline = 'W'.repeat(100);
    const typography = planCoverTypography({ title, subtitle, byline, geometry: COVER_GEOMETRY, font: proportionalCoverFont });
    const lines = [...typography.title, ...typography.subtitle, ...typography.byline];
    const safeRight = typography.safeBox.x + typography.safeBox.width;
    const safeTop = typography.safeBox.y + typography.safeBox.height;

    expect(typography.title.map(line => line.text).join('')).toBe(title);
    expect(typography.subtitle.map(line => line.text).join('')).toBe(subtitle);
    expect(typography.byline.map(line => line.text).join('')).toBe(byline);
    for (const line of lines) {
      expect(line.x).toBeGreaterThanOrEqual(typography.safeBox.x);
      expect(line.x + line.width).toBeLessThanOrEqual(safeRight);
      expect(line.y).toBeGreaterThanOrEqual(typography.safeBox.y);
      expect(line.y + line.size).toBeLessThanOrEqual(safeTop);
    }
    for (const group of [typography.title, typography.subtitle, typography.byline]) {
      for (let index = 1; index < group.length; index += 1) {
        expect(group[index]!.y + group[index]!.size).toBeLessThanOrEqual(group[index - 1]!.y);
      }
    }
    expect(textBounds(typography.subtitle).top).toBeLessThan(textBounds(typography.title).bottom);
    expect(textBounds(typography.byline).top).toBeLessThan(textBounds(typography.subtitle).bottom);

    const sourceDraft = draft('modern', [selection('one', 0)]);
    sourceDraft.title = title;
    sourceDraft.subtitle = subtitle;
    sourceDraft.byline = byline;
    const snapshot = createCookbookPrintSnapshot({
      id: 'long-cover-copy',
      ownerUid: 'owner',
      draft: sourceDraft,
      recipes: [recipe('one')],
      now: new Date(NOW),
    });
    const artifacts = await renderCookbookPdfs(snapshot, layoutCookbook(snapshot), { coverGeometry: COVER_GEOMETRY });
    const cover = await PDFDocument.load(artifacts.cover);
    expect(cover.getPageCount()).toBe(1);
    expect(cover.getTitle()).toBe(title);
    expect(cover.getAuthor()).toBe(byline);
    const coverPage = cover.getPage(0);
    expect(coverPage.getSize()).toEqual({ width: COVER_GEOMETRY.pageWidthPt, height: COVER_GEOMETRY.pageHeightPt });
    expect(coverPage.getBleedBox()).toEqual({
      x: 0,
      y: 0,
      width: COVER_GEOMETRY.pageWidthPt,
      height: COVER_GEOMETRY.pageHeightPt,
    });
    expect(coverPage.getTrimBox()).toEqual({
      x: COVER_GEOMETRY.backXPt,
      y: COVER_GEOMETRY.pageHeightPt - COVER_GEOMETRY.trimTopPt - COVER_GEOMETRY.trimHeightPt,
      width: COVER_GEOMETRY.backWidthPt + COVER_GEOMETRY.spineWidthPt + COVER_GEOMETRY.frontWidthPt,
      height: COVER_GEOMETRY.trimHeightPt,
    });
    expect(hasEmbeddedFont(cover)).toBe(true);
  }, 60_000);
});

describe('quotes, state machines and ownership', () => {
  const quote: CookbookPrintQuote = {
    id: 'quote-1',
    draftId: 'draft-1',
    sku: 'matte-softcover',
    quantity: 1,
    printing: { amountMinor: 2_000, currency: 'CAD' },
    shipping: { amountMinor: 800, currency: 'CAD' },
    tax: { amountMinor: 364, currency: 'CAD' },
    discount: { amountMinor: 0, currency: 'CAD' },
    total: { amountMinor: 3_164, currency: 'CAD' },
    taxStatus: 'estimated',
    shippingMethod: 'MAIL',
    provider: 'lulu',
    providerName: 'Lulu Press, Inc.',
    createdAt: '2026-09-29T15:00:00.000Z',
    expiresAt: '2026-09-29T15:30:00.000Z',
  };

  test('treats invalid and boundary-time quotes as expired and binds every price-sensitive input', () => {
    expect(quoteExpired(quote, new Date('2026-09-29T15:29:59.999Z'))).toBe(false);
    expect(quoteExpired(quote, new Date(quote.expiresAt))).toBe(true);
    expect(quoteExpired({ ...quote, expiresAt: 'not-a-date' })).toBe(true);

    const binding = quoteBinding(quote, 'address-a', 'snapshot-a');
    expect(quoteBinding({ ...quote }, 'address-a', 'snapshot-a')).toBe(binding);
    expect(quoteBinding({ ...quote, total: { ...quote.total, amountMinor: quote.total.amountMinor + 1 } }, 'address-a', 'snapshot-a')).not.toBe(binding);
    expect(quoteBinding(quote, 'address-b', 'snapshot-a')).not.toBe(binding);
    expect(quoteBinding(quote, 'address-a', 'snapshot-b')).not.toBe(binding);
    expect(quoteBinding({ ...quote, shippingMethod: 'EXPRESS' }, 'address-a', 'snapshot-a')).not.toBe(binding);
  });

  test('allows only the declared fulfillment transitions', () => {
    const states: CookbookPrintFulfillmentStatus[] = [
      'awaiting-payment', 'submitting', 'submission-failed', 'submission-unknown', 'submitted',
      'in-production', 'shipped', 'delivered', 'cancelled', 'reprint-requested', 'reprinting', 'failed',
    ];
    const allowed: Record<CookbookPrintFulfillmentStatus, CookbookPrintFulfillmentStatus[]> = {
      'awaiting-payment': ['submitting', 'cancelled', 'failed'],
      submitting: ['submitted', 'in-production', 'shipped', 'delivered', 'submission-failed', 'submission-unknown', 'cancelled', 'failed'],
      'submission-failed': ['submitting', 'submitted', 'in-production', 'shipped', 'delivered', 'cancelled', 'reprint-requested', 'failed'],
      'submission-unknown': ['submitting', 'submitted', 'in-production', 'shipped', 'delivered', 'submission-failed', 'cancelled', 'failed'],
      submitted: ['in-production', 'shipped', 'delivered', 'cancelled', 'failed'],
      'in-production': ['shipped', 'delivered', 'cancelled', 'failed', 'reprint-requested'],
      shipped: ['delivered', 'failed', 'reprint-requested'],
      delivered: ['reprint-requested'],
      cancelled: [],
      'reprint-requested': ['reprinting', 'cancelled'],
      reprinting: ['reprint-requested', 'in-production', 'shipped', 'delivered', 'failed'],
      failed: ['awaiting-payment', 'reprint-requested'],
    };
    for (const from of states) {
      for (const to of states) {
        expect(canTransitionFulfillment(from, to)).toBe(from === to || allowed[from].includes(to));
      }
    }
  });

  test('allows only the declared payment transitions', () => {
    const states: CookbookPrintPaymentStatus[] = ['requires-payment', 'processing', 'paid', 'refund-pending', 'refunded', 'failed'];
    const allowed: Record<CookbookPrintPaymentStatus, CookbookPrintPaymentStatus[]> = {
      'requires-payment': ['processing', 'paid', 'refund-pending', 'refunded', 'failed'],
      processing: ['paid', 'refund-pending', 'refunded', 'failed'],
      paid: ['refund-pending', 'refunded'],
      'refund-pending': ['refunded', 'paid', 'failed'],
      refunded: ['paid'],
      failed: ['requires-payment'],
    };
    for (const from of states) {
      for (const to of states) {
        expect(canTransitionPayment(from, to)).toBe(from === to || allowed[from].includes(to));
      }
    }
  });

  test('returns not-found semantics when a caller does not own a private print resource', () => {
    expect(() => assertPrintOwner('owner', 'owner')).not.toThrow();
    try {
      assertPrintOwner('owner', 'attacker');
      throw new Error('expected owner check to fail');
    } catch (error: any) {
      expect(error.message).toBe('Not found.');
      expect(error.code).toBe('NOT_FOUND');
      expect(error.status).toBe(404);
    }
  });
});
