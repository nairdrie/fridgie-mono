// Item is an OPEN/extensible contract (backend handoff §3.1): the client may
// attach fields the server doesn't know about (e.g. overrideBase), and every
// server code path that maps items must copy unknown keys through.
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
    // aggregated total captured when overrideQuantity was set; the client uses
    // it to detect stale overrides. Stored opaquely, never interpreted here.
    overrideBase?: string;
    [key: string]: unknown;
  };

export type List = {
    id: string; // Firestore document ID
    weekStart: string;
    hasContent?: boolean;
    items: Item[];
    meals: Meal[];
    sort?: string;
    // monotonically increasing revision, bumped on every committed mutation
    rev?: number;
    // clientId of the writer for client saves; absent for server-side writes
    lastClientId?: string | null;
};

// types/types.ts
export interface Group {
  id: string;
  name: string;
  members: UserProfile[]
}

export interface Meal {
  id: string;
  listId: string;
  dayOfWeek?: 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday';
  name: string;
  recipeId?: string;
  addedToCookbook?: boolean; 
}

export enum ListView {
  GroceryList = 'list',
  MealPlan = 'plan'
}

export interface UserProfile {
  uid: string;
  email: string | null;
  phoneNumber: string | null;
  photoURL: string | null;
  displayName?: string | null;
  // Add other properties from your user document here
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
  ingredients: Ingredient [];
  instructions: string[];
}

export interface GroupInvitation {
  createdAt: string,
  groupId: string,
  groupName: string,
  inviteeUid: string,
  inviterName: string, 
  inviterUid: string,
  status: string
}