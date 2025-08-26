// components/MealPlanView.tsx
import { Item, Meal } from "@/types/types";
import React, { useMemo } from 'react';
import { FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import MealCard from "./MealCard"; // Import the new component

const DAYS_OF_WEEK: Meal['dayOfWeek'][] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOrder = new Map(DAYS_OF_WEEK.map((day, i) => [day, i]));

interface MealPlanViewProps {
  meals: Meal[];
  items: Item[];
  setAllItems: (callback: (prevItems: Item[]) => Item[]) => void;
  onUpdateMeal: (mealId: string, updates: Partial<Meal>) => void;
  onDeleteMeal: (mealId: string) => void;
  onAddMeal: () => void;
  
  // ✅ Add the new props to the interface
  editingId: string;
  setEditingId: React.Dispatch<React.SetStateAction<string>>;
  inputRefs: React.MutableRefObject<Record<string, TextInput | null>>;
  isKeyboardVisible: boolean;
  markDirty: () => void;
}

export default function MealPlanView({
  meals,
  items,
  setAllItems,
  onUpdateMeal,
  onDeleteMeal,
  onAddMeal,
  // ✅ Destructure the new props
  editingId,
  setEditingId,
  inputRefs,
  isKeyboardVisible,
  markDirty
}: MealPlanViewProps) {

  const sortedMeals = useMemo(() => {
    return [...meals].sort((a, b) => {
      const aHasDay = a.dayOfWeek && dayOrder.has(a.dayOfWeek);
      const bHasDay = b.dayOfWeek && dayOrder.has(b.dayOfWeek);

      if (aHasDay && !bHasDay) return -1; // a comes first
      if (!aHasDay && bHasDay) return 1;  // b comes first
      
      if (aHasDay && bHasDay) {
        // Both have days, sort by day of the week
        return dayOrder.get(a.dayOfWeek!)! - dayOrder.get(b.dayOfWeek!)!;
      }
      
      // Neither have days, sort alphabetically by name
      return a.name.localeCompare(b.name);
    });
  }, [meals]);

  return (
    <>
     { sortedMeals.length == 0 && 
      <View style={styles.emptyMealsContainer}>
        <Text style={styles.emptyMealsText}>Let's get cooking!</Text>
        <TouchableOpacity 
            style={styles.addMealButton}
            onPress={onAddMeal}>
            <Text style={styles.addMealText}>+ Add Meal</Text>
        </TouchableOpacity>
      </View>
     }
      <FlatList
        data={sortedMeals}
        keyExtractor={(item) => item.id}
        renderItem={({ item: meal }) => (
          <MealCard
            meal={meal}
            allItems={items}
            setAllItems={setAllItems}
            onUpdateMeal={onUpdateMeal}
            onDeleteMeal={onDeleteMeal}
            // ✅ Pass the props down to each MealCard
            editingId={editingId}
            setEditingId={setEditingId}
            inputRefs={inputRefs}
            isKeyboardVisible={isKeyboardVisible}
            markDirty={markDirty}
          />
        )}
        contentContainerStyle={styles.container}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 10,
  },
  emptyMealsContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 100
  },
  emptyMealsText: {
    fontSize: 28,
    fontWeight: 'bold',
    color: 'grey'

  },
  addMealButton: { paddingVertical: 5 },
  addMealText: { color: '#007AFF', fontSize: 16, textAlign: 'center'  }
});