export type Item = {
    id: string;
    text: string;
    checked: boolean;
    listOrder: string; // ✅ Renamed from 'order'
    mealOrder?: string; // ✅ New optional field for ordering within a meal
    isSection: boolean; // Optional property to indicate if the item is a section
    mealId?: string;
  };
  
export type List = {
    id: string; // Firestore document ID
    weekStart: string;
    hasContent?: boolean;
    items: Item[];
    meals: Meal[];
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
  // Add other properties from your user document here
}