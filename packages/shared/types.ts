// The shared client/server data contract.
//
// TYPE-ONLY — no enums, no consts, no functions. Everything here is erased at
// compile time, so Metro and EAS never resolve this file. `ListView` deliberately
// stays in the mobile app because an `enum` is a runtime value.
//
// Reconciled from the two copies that had drifted apart; where they disagreed the
// side that matches actual runtime behaviour won, noted per field below.

/**
 * A grocery/meal item.
 *
 * Deliberately STRICT here so typos still fail typechecking. Server code paths
 * that read and re-emit items must use `OpenItem` and copy unknown keys through
 * — the client attaches fields the server doesn't know about (`overrideBase`),
 * and dropping them silently breaks stale-override detection.
 */
export type Item = {
  id: string;
  text: string;
  checked: boolean;
  listOrder: string;
  mealOrder?: string;
  isSection: boolean;
  mealId?: string;
  quantity?: string;
  overrideQuantity?: string;
  /**
   * Aggregated total of all same-named items at the moment overrideQuantity was
   * set. When the recomputed total no longer matches, the override is stale and
   * ignored. Stored opaquely; the server never interprets it.
   */
  overrideBase?: string;
  /**
   * The aisle this item has been filed under, stamped by the server when it
   * categorizes. Its absence is what marks a row as still needing a department,
   * which is how auto-categorization survives an app restart and a second
   * device: position alone cannot tell a newly appended row from one that
   * genuinely belongs to the last section. Cleared by the client whenever the
   * text changes, so a renamed item is re-filed.
   */
  section?: string;
  /**
   * The user has promoted this row back into the list body for this shop, even
   * though its ingredient is one of the household's staples.
   *
   * Per-row and per-week rather than a change to the staple itself, because
   * "I'm out of olive oil this week" and "we don't actually always have olive
   * oil" are different statements. The second one is what
   * DELETE /api/staples/:key is for.
   */
  stapleOverride?: boolean;
  /**
   * Wall-clock stamp of the last LOCAL edit to this row, written by whichever
   * client made the change. Exists solely so a three-way merge can break a
   * genuine collision — two people changing the SAME field of the SAME row
   * between two saves. Every other conflict resolves structurally, so a phone
   * with a wrong clock can at worst pick the wrong side of that collision; it
   * can never lose a row or bring a deleted one back.
   *
   * The server neither reads nor writes it. It survives a round trip because
   * `sanitizeItems` carries unknown keys through untouched.
   */
  updatedAt?: number;
};

/** Item as it crosses the wire: open/extensible, unknown keys preserved. */
export type OpenItem = Item & Record<string, unknown>;

export type ListSort = 'alphabetical' | 'category' | 'custom';

/**
 * What GET /api/list actually returns — a three-field summary, NOT a full list.
 * Typing that response as `List` claimed `items`/`meals` were present arrays
 * when both are undefined at runtime.
 */
export type ListSummary = {
  id: string;
  /** Bare `yyyy-MM-dd` Sunday key, computed in the requesting client's timezone. */
  weekStart: string;
  hasContent?: boolean;
};

/** A full list document: GET /api/list/:id and websocket frames. */
export type List = ListSummary & {
  items: Item[];
  /** Absent on freshly created lists — they're written with no `meals` key. */
  meals?: Meal[];
  /** Union rather than the server's old bare `string` — these are the only values written. */
  sort?: ListSort;
  /** Monotonically increasing revision, bumped on every committed mutation. */
  rev?: number;
  /** clientId of the writer for client saves; null for server-initiated writes. */
  lastClientId?: string | null;
};

export interface Group {
  id: string;
  name: string;
  members: UserProfile[];
  /** GET /api/group emits this; the server's old copy was missing it. */
  owner: string;
  /**
   * People this household actually cooks for, which is not the same as how
   * many of them have the app — a couple where one partner never installed it
   * is a group of one.
   *
   * Absent means DO NOT SCALE, and deliberately not "fall back to
   * `members.length`": most groups have exactly one member, so that fallback
   * would quietly quarter every quantity for every solo user the day it
   * shipped, and someone cooking alone very often still cooks four portions.
   * Scaling only ever happens because someone said what their household is.
   */
  householdSize?: number;
}

export type DayOfWeek =
  | 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday'
  | 'Thursday' | 'Friday' | 'Saturday';

export interface Meal {
  id: string;
  listId: string;
  dayOfWeek?: DayOfWeek;
  name: string;
  recipeId?: string;
  addedToCookbook?: boolean;
  /**
   * What the recipe's quantities were multiplied by when this meal's
   * ingredients were put on the list.
   *
   * Stored rather than recomputed on read, because the household size can
   * change after the shop: recomputing would make the cooking view quietly
   * disagree with the amounts that were actually bought. Absent means 1.
   */
  scale?: number;
  /** Merge tiebreak stamp — see `Item.updatedAt`. */
  updatedAt?: number;
}

/**
 * `email` and `phoneNumber` are OPTIONAL: the three endpoints that emit profiles
 * each send a different subset. Group members arrive as {uid, displayName,
 * photoURL} only, so declaring them required made `member.email.split('@')` look
 * type-safe when it throws at runtime.
 */
export interface UserProfile {
  uid: string;
  email?: string | null;
  phoneNumber?: string | null;
  photoURL?: string | null;
  displayName?: string | null;
  /** Social counters — populated by the user/explore/follow endpoints only. */
  followerCount?: number;
  followingCount?: number;
  isFollowing?: boolean;
}

/**
 * What holds for this person EVERY time they ask for a suggestion.
 *
 * Deliberately only the two things that don't move: what they can't eat, and
 * what they won't eat. Cuisine and cooking style used to live here too, but
 * those track the mood of the day rather than the person — a global "I like
 * Italian" quietly steered every suggestion forever — so they are now picked as
 * hints at generation time instead. See `SuggestionRequest.hints`.
 */
export interface MealPreferences {
  /** Hard constraints: vegan, gluten-free, allergies. */
  dietaryNeeds?: string[];
  /** Free text — ingredients never to suggest. */
  dislikedIngredients?: string;

  /**
   * Legacy, still present on user documents written before hints existed. Kept
   * on the type so those documents parse; nothing reads them as constraints.
   */
  cookingStyles?: string[];
  cuisines?: string[];
  query?: string;
}

/** One turn of the suggestion conversation, as the client replays it. */
export interface SuggestionTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Everything that applies to ONE generation and is never persisted.
 *
 * This is the whole point of the split: a vegan cooking for their family on a
 * Sunday can drop the vegan constraint for one set of suggestions without
 * editing who they are.
 */
export interface SuggestionRequest {
  /** Titles already shown this session, so a re-roll doesn't repeat them. */
  vetoedTitles?: string[];
  /**
   * Preferences as they apply to THIS generation. A field that is PRESENT
   * replaces the stored one; absent means "use what's saved". Present-and-empty
   * is how "I switched vegan off just for tonight" is expressed, which is why
   * this is a nested object rather than optional fields on the body.
   */
  overrides?: {
    dietaryNeeds?: string[];
    dislikedIngredients?: string;
  };
  /** Cuisine / style / mood tags chosen for this generation only. */
  hints?: string[];
  /** Free text from the chat box. */
  query?: string;
  /** Prior turns, oldest first, so a follow-up knows what it follows up on. */
  conversation?: SuggestionTurn[];
}

export interface Ingredient {
  name: string;
  quantity: string;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  photoURL?: string;
  ingredients: Ingredient[];
  instructions: string[];
  /**
   * People this recipe was written to feed.
   *
   * Read from the source's own `recipeYield` on import, asked of the model on
   * generation, and editable by hand. Absent on every recipe written before
   * this field existed, which is exactly why everything downstream reads
   * absent as "don't scale" rather than assuming the prompt's serves-4.
   */
  servings?: number;
  /** Server-generated on import/suggest, and indexed for search. */
  tags?: string[];
  /** Set by the server; used to decide whether editing forks the recipe. */
  createdBy?: string;
  forkedFromId?: string;

  // ── Server-DERIVED, read-only ────────────────────────────────────────────
  // Synthesised per-request from `createdBy`; never stored. POST /api/recipe
  // strips them, so sending them back is harmless but pointless — previously
  // it persisted the original author onto every fork.
  authorName?: string;
  authorUid?: string;
  lastAte?: string;
}

/** The raw invitation document as stored. */
export interface GroupInvitation {
  createdAt: string;
  groupId: string;
  groupName: string;
  inviteeUid: string;
  inviterName: string;
  inviterUid: string;
  status: string;
}

/** The enriched invitation the API returns to the client. Distinct from the stored doc. */
export interface PendingInvitation {
  id: string;
  groupId: string;
  groupName: string;
  inviterName: string;
  invitee: UserProfile;
}

export interface UserSearchResult {
  /** From Algolia. */
  objectID: string;
  displayName: string;
  photoURL: string;
  email: string;
  followerCount?: number;
  recipeCount?: number;
}

/** Body accepted by POST /api/list/:id. */
export interface UpdateListBody {
  items?: Item[];
  meals?: Meal[];
  sort?: ListSort;
  /** Last rev this client saw; omit only for first write. Stale → 409. */
  rev?: number;
  /** Stable per-app-instance id, so the server can tag its broadcast. */
  clientId?: string;
}

/** 409 response body from POST /api/list/:id. */
export interface StaleRevResponse {
  error: 'stale_rev';
  rev: number;
  list: List;
}
