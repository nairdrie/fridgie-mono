export type Item = {
    id: string;
    text: string;
    checked: boolean;
    order: string; // LexoRank string
    isSection: boolean; // Optional property to indicate if the item is a section
  };
  
export type List = {
    id: string; // Firestore document ID
    weekStart: string;
    hasContent?: boolean;
    items?: Item[];
};

// types/types.ts
export interface Group {
  id: string;
  name: string;
}