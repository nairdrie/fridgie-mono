import { describe, expect, test } from 'bun:test'
import type {
  CookbookPrintAddress,
  CookbookPrintDraft,
  CookbookPrintEligibleRecipe,
  CookbookPrintPreview,
  CookbookPrintQuote,
  CookbookPrintRecipeSelection,
} from '@/types/types'
import {
  arePrintAcknowledgementsComplete,
  buildInitialPrintSelections,
  canCheckoutPrintCookbook,
  canRequestPrintQuote,
  createInitialPrintSelections,
  getPrintCheckoutBlocker,
  getPrintCheckoutBlockers,
  getCookbookPrintQuoteChange,
  includedPrintSelections,
  isPrintAddressComplete,
  isPrintPreviewCurrent,
  isPrintQuoteUnexpired,
  removePrintRecipe,
  reconcilePrintSelections,
  reorderIncludedPrintRecipes,
  restorePrintRecipe,
  selectPrintRecipe,
  togglePrintRecipe,
  withPrintSelections,
} from './printCookbook'

const eligibleRecipe = (
  id: string,
  extra: Partial<CookbookPrintEligibleRecipe> = {},
): CookbookPrintEligibleRecipe => ({
  id,
  name: id,
  description: '',
  ingredients: [],
  instructions: [],
  printRestriction: 'none',
  defaultRightsMode: 'original-or-licensed',
  photoPrintAllowedByDefault: true,
  ...extra,
})

const selection = (
  recipeId: string,
  position: number,
  extra: Partial<CookbookPrintRecipeSelection> = {},
): CookbookPrintRecipeSelection => ({
  recipeId,
  position,
  included: true,
  photoPlacement: 'auto',
  rightsMode: 'original-or-licensed',
  ...extra,
})

const draft: CookbookPrintDraft = {
  id: 'draft-1',
  revision: 4,
  status: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  title: 'Family recipes',
  byline: 'The Family',
  theme: 'classic',
  sku: 'matte-hardcover',
  coverCrop: { x: 0.5, y: 0.5, zoom: 1 },
  includeTableOfContents: true,
  includeIndex: true,
  recipes: [],
}

const preview: CookbookPrintPreview = {
  draftId: draft.id,
  revision: draft.revision,
  generatedAt: '2026-09-01T00:00:00.000Z',
  pageCount: 48,
  spineWidthInches: 0.3,
  pages: [],
  issues: [],
  canOrder: true,
}

const money = { amountMinor: 100, currency: 'CAD' }
const quote: CookbookPrintQuote = {
  id: 'quote-1',
  draftId: draft.id,
  sku: draft.sku,
  quantity: 1,
  printing: money,
  shipping: money,
  tax: money,
  discount: { amountMinor: 0, currency: 'CAD' },
  total: { amountMinor: 300, currency: 'CAD' },
  taxStatus: 'estimated',
  shippingMethod: 'standard',
  provider: 'lulu',
  providerName: 'Lulu',
  createdAt: '2026-09-01T00:00:00.000Z',
  expiresAt: '2026-09-01T01:00:00.000Z',
}

const address: CookbookPrintAddress = {
  name: 'Ada Lovelace',
  line1: '123 Kitchen Lane',
  city: 'Toronto',
  stateOrProvince: 'ON',
  postalCode: 'M5V 1A1',
  country: 'CA',
  phone: '+14165550123',
}

const acknowledgements = {
  rightsConfirmed: true,
  reviewedEveryPage: true,
  providerConsent: true,
}
const now = Date.parse('2026-09-01T00:30:00.000Z')

describe('initial print recipe state', () => {
  test('selects eligible recipes in input order with server-provided rights defaults', () => {
    const result = createInitialPrintSelections([
      eligibleRecipe('mine'),
      eligibleRecipe('source-only', {
        defaultRightsMode: 'source-only',
        photoPrintAllowedByDefault: false,
      }),
    ])

    expect(result).toEqual([
      {
        recipeId: 'mine',
        included: true,
        position: 0,
        photoPlacement: 'auto',
        rightsMode: 'original-or-licensed',
      },
      {
        recipeId: 'source-only',
        included: true,
        position: 1,
        photoPlacement: 'none',
        rightsMode: 'source-only',
      },
    ])
  })

  test('reconciles refreshed eligibility without losing edits or stable positions', () => {
    const existing = [
      selection('kept', 2, { included: false, notes: 'Grandma used nutmeg' }),
      selection('gone', 7),
    ]
    const result = reconcilePrintSelections([
      eligibleRecipe('new', { photoPrintAllowedByDefault: false }),
      eligibleRecipe('kept'),
    ], existing)

    expect(result).toEqual([
      selection('kept', 2, { included: false, notes: 'Grandma used nutmeg' }),
      selection('new', 3, { photoPlacement: 'none' }),
    ])
    expect(buildInitialPrintSelections([eligibleRecipe('kept')]))
      .toEqual(createInitialPrintSelections([eligibleRecipe('kept')]))
  })
})

describe('selection edits', () => {
  const rows = [selection('a', 0), selection('b', 1), selection('c', 2)]

  test('toggle, select, remove and restore never change a recipe position', () => {
    const toggled = togglePrintRecipe(rows, 'b')
    expect(toggled[1]).toMatchObject({ recipeId: 'b', included: false, position: 1 })
    expect(togglePrintRecipe(toggled, 'b')[1]).toMatchObject({ included: true, position: 1 })

    const removed = removePrintRecipe(rows, 'b')
    expect(includedPrintSelections(removed).map((row) => row.recipeId)).toEqual(['a', 'c'])
    expect(restorePrintRecipe(removed, 'b').map((row) => [row.recipeId, row.position])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ])
    expect(selectPrintRecipe(rows, 'b')).toEqual(rows)
  })

  test('does not mutate its input', () => {
    const original = rows.map((row) => ({ ...row }))
    removePrintRecipe(rows, 'a')
    expect(rows).toEqual(original)
  })

  test('reorders included slots while a removed recipe stays restorable', () => {
    const withRemoved = removePrintRecipe(rows, 'b')
    const reordered = reorderIncludedPrintRecipes(withRemoved, ['c', 'a'])

    expect(reordered.map((row) => [row.recipeId, row.included, row.position])).toEqual([
      ['c', true, 0],
      ['b', false, 1],
      ['a', true, 2],
    ])
    expect(restorePrintRecipe(reordered, 'b').map((row) => row.recipeId)).toEqual(['c', 'b', 'a'])
  })

  test('ignores duplicate/unknown drag ids and preserves omitted included rows', () => {
    const reordered = reorderIncludedPrintRecipes(rows, ['c', 'unknown', 'c'])
    expect(reordered.map((row) => row.recipeId)).toEqual(['c', 'a', 'b'])
  })

  test('updates either a new draft input or a saved draft without dropping metadata', () => {
    const next = withPrintSelections(draft, rows)
    expect(next.id).toBe(draft.id)
    expect(next.revision).toBe(draft.revision)
    expect(next.recipes).toEqual(rows)
    expect(next.recipes).not.toBe(rows)
  })
})

describe('checkout gating', () => {
  const ready = { draft, preview, quote, address, acknowledgements }

  test('accepts trimmed required address fields and ignores optional ones', () => {
    expect(isPrintAddressComplete({ ...address, name: '  Ada  ', line2: undefined })).toBe(true)
    expect(isPrintAddressComplete({ ...address, postalCode: '  ' })).toBe(false)
    expect(isPrintAddressComplete({ ...address, stateOrProvince: 'Ontario' })).toBe(false)
    expect(isPrintAddressComplete({ ...address, phone: '123' })).toBe(false)
    expect(isPrintAddressComplete(null)).toBe(false)
  })

  test('treats a quote as expired at its exact expiry instant', () => {
    expect(isPrintQuoteUnexpired(quote, now)).toBe(true)
    expect(isPrintQuoteUnexpired(quote, Date.parse(quote.expiresAt))).toBe(false)
    expect(isPrintQuoteUnexpired({ ...quote, expiresAt: 'not-a-date' }, now)).toBe(false)
  })

  test('requires a preview from the current draft revision', () => {
    expect(isPrintPreviewCurrent(preview, draft)).toBe(true)
    expect(isPrintPreviewCurrent({ ...preview, revision: draft.revision - 1 }, draft)).toBe(false)
    expect(isPrintPreviewCurrent({ ...preview, draftId: 'another-draft' }, draft)).toBe(false)
  })

  test('requires all checkout acknowledgements', () => {
    expect(arePrintAcknowledgementsComplete(acknowledgements)).toBe(true)
    expect(arePrintAcknowledgementsComplete({ ...acknowledgements, rightsConfirmed: false })).toBe(false)
    expect(arePrintAcknowledgementsComplete(null)).toBe(false)
  })

  test('allows checkout only when address, preview, quote and acknowledgements are ready', () => {
    expect(canRequestPrintQuote(ready)).toBe(true)
    expect(getPrintCheckoutBlockers(ready, now)).toEqual([])
    expect(getPrintCheckoutBlocker(ready, now)).toBeNull()
    expect(canCheckoutPrintCookbook(ready, now)).toBe(true)
  })

  test('does not request a quote for an incomplete address or blocked preview', () => {
    expect(canRequestPrintQuote({ ...ready, address: { ...address, line1: '' } })).toBe(false)
    expect(canRequestPrintQuote({ ...ready, preview: { ...preview, canOrder: false } })).toBe(false)
    expect(canRequestPrintQuote({ ...ready, preview: { ...preview, revision: 3 } })).toBe(false)
  })

  test('reports every blocker so the screen can explain disabled checkout', () => {
    const blockers = getPrintCheckoutBlockers({
      draft,
      preview: { ...preview, revision: 3, canOrder: false },
      quote: { ...quote, draftId: 'another-draft', expiresAt: '2026-08-31T00:00:00.000Z' },
      address: { ...address, city: '' },
      acknowledgements: { ...acknowledgements, rightsConfirmed: false },
    }, now)

    expect(blockers).toEqual([
      'address-incomplete',
      'preview-stale',
      'quote-mismatch',
      'quote-expired',
      'acknowledgements-incomplete',
    ])
    expect(getPrintCheckoutBlocker({
      ...ready,
      address: { ...address, city: '' },
    }, now)).toBe('address-incomplete')
  })

  test('uses canOrder only after confirming the preview is current', () => {
    expect(getPrintCheckoutBlockers({ ...ready, preview: { ...preview, canOrder: false } }, now))
      .toEqual(['preview-blocked'])
  })

  test('distinguishes missing preview and quote from stale state', () => {
    expect(getPrintCheckoutBlockers({ ...ready, preview: null, quote: null }, now))
      .toEqual(['preview-missing', 'quote-missing'])
  })
})

describe('checkout quote conflicts', () => {
  test('safely exposes a server replacement quote retained by ApiError', () => {
    const change = getCookbookPrintQuoteChange({
      status: 409,
      code: 'QUOTE_CHANGED',
      body: { error: 'QUOTE_CHANGED', message: 'Price refreshed', quote },
    })

    expect(change?.replacementQuote).toEqual(quote)
  })

  test('recognizes the conflict but rejects malformed replacement pricing', () => {
    const change = getCookbookPrintQuoteChange({
      status: 409,
      code: 'QUOTE_CHANGED',
      body: { quote: { ...quote, total: { amountMinor: '300', currency: 'CAD' } } },
    })

    expect(change).toEqual({ replacementQuote: null })
  })

  test('rejects a valid replacement quote for a different draft', () => {
    const change = getCookbookPrintQuoteChange({
      status: 409,
      code: 'QUOTE_CHANGED',
      body: { quote: { ...quote, draftId: 'another-draft' } },
    }, draft)

    expect(change).toEqual({ replacementQuote: null })
  })

  test('does not treat unrelated API failures as quote changes', () => {
    expect(getCookbookPrintQuoteChange({
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
      body: { quote },
    })).toBeNull()
  })
})
