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

export interface MealPreferences {
  dietaryNeeds?: string[];
  cookingStyles?: string[];
  cuisines?: string[];
  dislikedIngredients?: string;
  query?: string;
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
