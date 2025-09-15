// /utils/recipeStyling.ts
import { Ionicons } from '@expo/vector-icons';

// Define the return type for our function
export interface CardStyle {
  backgroundColor: string;
  icon: keyof typeof Ionicons.glyphMap; // This ensures we use valid Ionicons names
}

// Define our tag-to-style mapping with priority order
const styleMappings: { tag: string; style: CardStyle }[] = [
  // --- Cuisines (Highest Priority) ---
  { tag: 'italian', style: { backgroundColor: '#e63946', icon: 'pizza-outline' } },
  { tag: 'mexican', style: { backgroundColor: '#fca311', icon: 'flame-outline' } },
  { tag: 'japanese', style: { backgroundColor: '#219ebc', icon: 'fish-outline' } },
  { tag: 'chinese', style: { backgroundColor: '#d62828', icon: 'bowl-outline' } },
  { tag: 'thai', style: { backgroundColor: '#8ac926', icon: 'leaf-outline' } },
  { tag: 'indian', style: { backgroundColor: '#ffb703', icon: 'bonfire-outline' } },
  { tag: 'mediterranean', style: { backgroundColor: '#00b4d8', icon: 'water-outline' } },
  { tag: 'american', style: { backgroundColor: '#023e8a', icon: 'flag-outline' } },

  // --- Meal Characteristics ---
  { tag: 'comfort food', style: { backgroundColor: '#dda15e', icon: 'heart-outline' } },
  { tag: 'quick & easy', style: { backgroundColor: '#4cc9f0', icon: 'stopwatch-outline' } },
  
  // --- Health & Dietary (Grouped) ---
  { tag: 'healthy & light', style: { backgroundColor: '#52b788', icon: 'fitness-outline' } },
  { tag: 'vegetarian', style: { backgroundColor: '#52b788', icon: 'leaf-outline' } },
  { tag: 'vegan', style: { backgroundColor: '#2d6a4f', icon: 'leaf' } },
  { tag: 'pescatarian', style: { backgroundColor: '#52b788', icon: 'fish-outline' } },

  // Add more mappings here if you like
];

// Define the default style
const defaultStyle: CardStyle = {
  backgroundColor: '#a3b18a', // A pleasant, earthy green
  icon: 'restaurant-outline',
};

export const getCardStyleFromTags = (tags?: string[]): CardStyle => {
  if (!tags || tags.length === 0) {
    return defaultStyle;
  }
  
  // Find the first matching style from our priority list
  for (const mapping of styleMappings) {
    if (tags.includes(mapping.tag)) {
      return mapping.style;
    }
  }

  // If no specific tags match, return the default
  return defaultStyle;
};