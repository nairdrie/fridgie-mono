import type {
  CookbookPrintAddress,
  CookbookPrintDraft,
  CookbookPrintDraftInput,
  CookbookPrintEligibleRecipe,
  CookbookPrintPreview,
  CookbookPrintQuote,
  CookbookPrintRecipeSelection,
} from '@/types/types'

type PrintRecipeDefaults = Pick<
  CookbookPrintEligibleRecipe,
  'id' | 'defaultRightsMode' | 'photoPrintAllowedByDefault'
>

/**
 * Builds the editable recipe rows for a new print draft.
 *
 * Eligibility is decided by the server before this helper is called. A recipe
 * whose photo cannot be printed still starts in the book, but with its photo
 * disabled; rights/source-only page handling is carried by `defaultRightsMode`.
 */
export function buildInitialPrintSelections(
  recipes: readonly PrintRecipeDefaults[],
): CookbookPrintRecipeSelection[] {
  return recipes.map((recipe, position) => ({
    recipeId: recipe.id,
    included: true,
    position,
    photoPlacement: recipe.photoPrintAllowedByDefault ? 'auto' : 'none',
    rightsMode: recipe.defaultRightsMode,
  }))
}

/** Backwards-friendly descriptive alias. */
export const createInitialPrintSelections = buildInitialPrintSelections

/** Rows in display/print order, including soft-removed rows. */
export function orderedPrintSelections(
  selections: readonly CookbookPrintRecipeSelection[],
): CookbookPrintRecipeSelection[] {
  return selections
    .map((selection, inputIndex) => ({ selection, inputIndex }))
    .sort((a, b) => a.selection.position - b.selection.position || a.inputIndex - b.inputIndex)
    .map(({ selection }) => selection)
}

/** Included rows in the exact order that will be printed. */
export function includedPrintSelections(
  selections: readonly CookbookPrintRecipeSelection[],
): CookbookPrintRecipeSelection[] {
  return orderedPrintSelections(selections).filter((selection) => selection.included)
}

/**
 * Merges a fresh server eligibility response into local draft state.
 *
 * Existing choices and order win, recipes no longer returned by the server are
 * dropped, and newly eligible recipes are appended with safe server defaults.
 */
export function reconcilePrintSelections(
  recipes: readonly PrintRecipeDefaults[],
  existing: readonly CookbookPrintRecipeSelection[] = [],
): CookbookPrintRecipeSelection[] {
  const eligibleIds = new Set(recipes.map((recipe) => recipe.id))
  const seen = new Set<string>()
  const reconciled = orderedPrintSelections(existing).filter((selection) => {
    if (!eligibleIds.has(selection.recipeId) || seen.has(selection.recipeId)) return false
    seen.add(selection.recipeId)
    return true
  })
  let nextPosition = reconciled.reduce(
    (max, selection) => Math.max(max, selection.position),
    -1,
  ) + 1

  for (const recipe of recipes) {
    if (seen.has(recipe.id)) continue
    const [initial] = buildInitialPrintSelections([recipe])
    reconciled.push({ ...initial, position: nextPosition++ })
    seen.add(recipe.id)
  }

  return reconciled
}

export function setPrintRecipeIncluded(
  selections: readonly CookbookPrintRecipeSelection[],
  recipeId: string,
  included: boolean,
): CookbookPrintRecipeSelection[] {
  return selections.map((selection) =>
    selection.recipeId === recipeId && selection.included !== included
      ? { ...selection, included }
      : selection,
  )
}

export function togglePrintRecipe(
  selections: readonly CookbookPrintRecipeSelection[],
  recipeId: string,
): CookbookPrintRecipeSelection[] {
  return selections.map((selection) =>
    selection.recipeId === recipeId
      ? { ...selection, included: !selection.included }
      : selection,
  )
}

export function selectPrintRecipe(
  selections: readonly CookbookPrintRecipeSelection[],
  recipeId: string,
): CookbookPrintRecipeSelection[] {
  return setPrintRecipeIncluded(selections, recipeId, true)
}

/** Soft-removes a recipe without changing its position or editing choices. */
export function removePrintRecipe(
  selections: readonly CookbookPrintRecipeSelection[],
  recipeId: string,
): CookbookPrintRecipeSelection[] {
  return setPrintRecipeIncluded(selections, recipeId, false)
}

/** Restores a soft-removed recipe at the position it retained. */
export function restorePrintRecipe(
  selections: readonly CookbookPrintRecipeSelection[],
  recipeId: string,
): CookbookPrintRecipeSelection[] {
  return setPrintRecipeIncluded(selections, recipeId, true)
}

/**
 * Applies a draggable list's recipe-id order to included rows only.
 *
 * Removed rows keep their slots. Unknown and duplicate ids are ignored, while
 * included ids omitted by a stale UI callback are appended in their prior
 * order. This makes the helper safe to call while selection state is changing.
 */
export function reorderIncludedPrintRecipes(
  selections: readonly CookbookPrintRecipeSelection[],
  orderedIncludedRecipeIds: readonly string[],
): CookbookPrintRecipeSelection[] {
  const ordered = orderedPrintSelections(selections)
  const includedById = new Map(
    ordered.filter((selection) => selection.included).map((selection) => [selection.recipeId, selection]),
  )
  const seen = new Set<string>()
  const reorderedIncluded: CookbookPrintRecipeSelection[] = []

  for (const recipeId of orderedIncludedRecipeIds) {
    const selection = includedById.get(recipeId)
    if (selection && !seen.has(recipeId)) {
      seen.add(recipeId)
      reorderedIncluded.push(selection)
    }
  }

  for (const selection of ordered) {
    if (selection.included && !seen.has(selection.recipeId)) {
      seen.add(selection.recipeId)
      reorderedIncluded.push(selection)
    }
  }

  let includedIndex = 0
  return ordered.map((slot) => {
    if (!slot.included) return slot
    const next = reorderedIncluded[includedIndex++]
    return next.position === slot.position ? next : { ...next, position: slot.position }
  })
}

/** Replaces recipe state without dropping whether this is a saved or new draft. */
export function withPrintSelections<T extends CookbookPrintDraftInput>(
  draft: T,
  recipes: readonly CookbookPrintRecipeSelection[],
): T {
  return { ...draft, recipes: [...recipes] }
}

const REQUIRED_ADDRESS_FIELDS = [
  'name',
  'line1',
  'city',
  'stateOrProvince',
  'postalCode',
  'country',
  'phone',
] as const satisfies readonly (keyof CookbookPrintAddress)[]

export function isPrintAddressComplete(
  address: Partial<CookbookPrintAddress> | null | undefined,
): address is CookbookPrintAddress {
  if (!address) return false
  if (!REQUIRED_ADDRESS_FIELDS.every((field) => {
    const value = address[field]
    return typeof value === 'string' && value.trim().length > 0
  })) return false
  const country = address.country!.trim().toUpperCase()
  const subdivision = address.stateOrProvince!.trim().toUpperCase()
  const phone = address.phone!.trim()
  return /^[A-Z]{2}$/.test(country)
    && (!['AU', 'CA', 'MX', 'US'].includes(country) || /^[A-Z]{2,3}$/.test(subdivision))
    && (!subdivision || /^[A-Z]{2,3}$/.test(subdivision))
    && /^\+?[\d\s\-.\/()]{8,20}$/.test(phone)
}

export function isPrintQuoteUnexpired(
  quote: CookbookPrintQuote | null | undefined,
  now: number | Date = Date.now(),
): quote is CookbookPrintQuote {
  if (!quote) return false
  const expiresAt = Date.parse(quote.expiresAt)
  const nowMs = now instanceof Date ? now.getTime() : now
  return Number.isFinite(expiresAt) && expiresAt > nowMs
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isPrintMoney(value: unknown): boolean {
  return isRecord(value)
    && Number.isInteger(value.amountMinor)
    && typeof value.currency === 'string'
    && /^[A-Z]{3}$/.test(value.currency)
}

/** Runtime guard for a replacement quote carried by a checkout conflict. */
function isCookbookPrintQuote(value: unknown): value is CookbookPrintQuote {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.draftId === 'string'
    && value.draftId.length > 0
    && (value.sku === 'matte-softcover' || value.sku === 'matte-hardcover')
    && value.quantity === 1
    && isPrintMoney(value.printing)
    && isPrintMoney(value.shipping)
    && isPrintMoney(value.tax)
    && isPrintMoney(value.discount)
    && isPrintMoney(value.total)
    && (value.taxStatus === 'included' || value.taxStatus === 'estimated' || value.taxStatus === 'unavailable')
    && typeof value.shippingMethod === 'string'
    && value.provider === 'lulu'
    && typeof value.providerName === 'string'
    && typeof value.createdAt === 'string'
    && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.expiresAt === 'string'
    && Number.isFinite(Date.parse(value.expiresAt))
    && (value.productionEstimate === undefined || typeof value.productionEstimate === 'string')
    && (value.deliveryEstimate === undefined || typeof value.deliveryEstimate === 'string')
}

export interface CookbookPrintQuoteChange {
  replacementQuote: CookbookPrintQuote | null
}

/**
 * Reads the structured 409 retained by `ApiError` without trusting arbitrary
 * response data as a quote. A QUOTE_CHANGED without a usable replacement is
 * still returned so callers can clear stale local pricing.
 */
export function getCookbookPrintQuoteChange(
  error: unknown,
  expectedDraft?: Pick<CookbookPrintDraft, 'id' | 'sku'>,
): CookbookPrintQuoteChange | null {
  if (!isRecord(error) || error.status !== 409 || error.code !== 'QUOTE_CHANGED') return null
  const body = isRecord(error.body) ? error.body : null
  const replacementQuote = body && isCookbookPrintQuote(body.quote) ? body.quote : null
  return {
    replacementQuote: replacementQuote
      && (!expectedDraft
        || (replacementQuote.draftId === expectedDraft.id && replacementQuote.sku === expectedDraft.sku))
      ? replacementQuote
      : null,
  }
}

export function isPrintPreviewCurrent(
  preview: CookbookPrintPreview | null | undefined,
  draft: Pick<CookbookPrintDraft, 'id' | 'revision'>,
): preview is CookbookPrintPreview {
  return Boolean(
    preview
      && preview.draftId === draft.id
      && preview.revision === draft.revision,
  )
}

export interface CookbookPrintAcknowledgements {
  rightsConfirmed: boolean
  reviewedEveryPage: boolean
  providerConsent: boolean
}

export function arePrintAcknowledgementsComplete(
  acknowledgements: CookbookPrintAcknowledgements | null | undefined,
): boolean {
  if (!acknowledgements) return false
  return acknowledgements.rightsConfirmed
    && acknowledgements.reviewedEveryPage
    && acknowledgements.providerConsent
}

export type CookbookPrintCheckoutBlocker =
  | 'address-incomplete'
  | 'preview-missing'
  | 'preview-stale'
  | 'preview-blocked'
  | 'quote-missing'
  | 'quote-mismatch'
  | 'quote-expired'
  | 'acknowledgements-incomplete'

export interface CookbookPrintCheckoutState {
  draft: CookbookPrintDraft
  preview?: CookbookPrintPreview | null
  quote?: CookbookPrintQuote | null
  address?: Partial<CookbookPrintAddress> | null
  acknowledgements?: CookbookPrintAcknowledgements | null
}

export type CookbookPrintQuoteRequestState = Pick<
  CookbookPrintCheckoutState,
  'draft' | 'preview' | 'address'
>

/** True when the inputs that determine a shippable price are ready. */
export function canRequestPrintQuote(state: CookbookPrintQuoteRequestState): boolean {
  return isPrintAddressComplete(state.address)
    && isPrintPreviewCurrent(state.preview, state.draft)
    && state.preview.canOrder
}

/**
 * Returns every reason checkout is blocked, suitable for both button state and
 * inline UI. Pass `now` from a timer to make quote expiry update reactively.
 */
export function getPrintCheckoutBlockers(
  state: CookbookPrintCheckoutState,
  now: number | Date = Date.now(),
): CookbookPrintCheckoutBlocker[] {
  const blockers: CookbookPrintCheckoutBlocker[] = []

  if (!isPrintAddressComplete(state.address)) blockers.push('address-incomplete')

  if (!state.preview) {
    blockers.push('preview-missing')
  } else if (!isPrintPreviewCurrent(state.preview, state.draft)) {
    blockers.push('preview-stale')
  } else if (!state.preview.canOrder) {
    blockers.push('preview-blocked')
  }

  if (!state.quote) {
    blockers.push('quote-missing')
  } else {
    if (state.quote.draftId !== state.draft.id || state.quote.sku !== state.draft.sku) {
      blockers.push('quote-mismatch')
    }
    if (!isPrintQuoteUnexpired(state.quote, now)) blockers.push('quote-expired')
  }

  if (!arePrintAcknowledgementsComplete(state.acknowledgements)) {
    blockers.push('acknowledgements-incomplete')
  }

  return blockers
}

export function canCheckoutPrintCookbook(
  state: CookbookPrintCheckoutState,
  now: number | Date = Date.now(),
): boolean {
  return getPrintCheckoutBlockers(state, now).length === 0
}

/** First blocker for compact UI, or null when checkout is ready. */
export function getPrintCheckoutBlocker(
  state: CookbookPrintCheckoutState,
  now: number | Date = Date.now(),
): CookbookPrintCheckoutBlocker | null {
  return getPrintCheckoutBlockers(state, now)[0] ?? null
}
