// components/MealPlanView.tsx
import { Item, Meal } from "@/types/types";
import { primary } from "@/utils/styles";
import React, { useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import MealCard from "./MealCard"; // Import the new component
import QuantityEditorModal from "./QuantityEditorModal";

const DAYS_OF_WEEK: Meal['dayOfWeek'][] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOrder = new Map(DAYS_OF_WEEK.map((day, i) => [day, i]));

interface MealPlanViewProps {
  meals: Meal[];
  items: Item[];
  setAllItems: (callback: (prevItems: Item[]) => Item[]) => void;
  onUpdateMeal: (mealId: string, updates: Partial<Meal>) => void;
  onDeleteMeal: (mealId: string) => void;
  onAddMeal: () => void;
  onAddRecipe: (meal: Meal) => void;
  collapsedMeals: Record<string, boolean>;
  onToggleMealCollapse: (mealId: string) => void;
  editingId: string;
  setEditingId: React.Dispatch<React.SetStateAction<string>>;
  inputRefs: React.MutableRefObject<Record<string, TextInput | null>>;
  isKeyboardVisible: boolean;
  markDirty: () => void;
  onViewRecipe: (meal: Meal) => void;
  onToggleCookbook: (meal: Meal) => void;
}

export default function MealPlanView({
  meals,
  items,
  setAllItems,
  onUpdateMeal,
  onDeleteMeal,
  onAddMeal,
  onViewRecipe,
  onAddRecipe,
  editingId,
  setEditingId,
  inputRefs,
  isKeyboardVisible,
  markDirty,
  collapsedMeals,
  onToggleMealCollapse,
  onToggleCookbook
}: MealPlanViewProps) {

  const [isModalVisible, setIsModalVisible] = useState(false);
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);

    const openQuantityEditor = (item: Item) => {
        setSelectedItem(item);
        setIsModalVisible(true);
    };

    const closeQuantityEditor = () => {
        setIsModalVisible(false);
        setSelectedItem(null);
    };

    const handleSaveQuantity = (newQuantity: string) => {
        if (!selectedItem) return;
        if(selectedItem.quantity === newQuantity) {
            closeQuantityEditor();
            return;
        }

        setAllItems(prev =>
            prev.map(i =>
                i.id === selectedItem.id
                    // If the input is empty, set quantity to null, otherwise save the trimmed value
                    ? { ...i, quantity: newQuantity.trim() || undefined }
                    : i
            )
        );
        markDirty();
        closeQuantityEditor();
    };

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
    <View style={{ flex: 1 }}>
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
     { sortedMeals.length > 0 && 
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
            editingId={editingId}
            setEditingId={setEditingId}
            inputRefs={inputRefs}
            isKeyboardVisible={isKeyboardVisible}
            markDirty={markDirty}
            onViewRecipe={onViewRecipe}
            onAddRecipe={onAddRecipe}
            isCollapsed={!!collapsedMeals[meal.id]}
            onToggleCollapse={onToggleMealCollapse}
            onToggleCookbook={onToggleCookbook}
            onOpenQuantityEditor={openQuantityEditor}
          />
        )}
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        windowSize={10}
        contentContainerStyle={styles.container}
      />
     }
      <QuantityEditorModal
          isVisible={isModalVisible}
          item={selectedItem}
          onSave={handleSaveQuantity}
          onClose={closeQuantityEditor}
      />
    </View>
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
  },
  emptyMealsText: {
    fontSize: 28,
    fontWeight: 'bold',
    color: 'grey'

  },
  addMealButton: { paddingVertical: 5 },
  addMealText: { color: primary, fontSize: 16, textAlign: 'center'  }
});