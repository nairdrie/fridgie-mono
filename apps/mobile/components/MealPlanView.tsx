// components/MealPlanView.tsx
import { Item, Meal } from "@/types/types";
import { formatQuantity, parseQuantity } from "@/utils/quantity";
import { primary } from "@/utils/styles";
import Ionicons from '@expo/vector-icons/Ionicons';
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
  onAddFromCookbook: () => void;
  onSuggestMeal: () => void;
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
  onAddFromCookbook,
  onSuggestMeal,
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

        // Normalize parseable input ("1 1/2 cup" -> "1.5 cups") so grocery-list
        // aggregation can convert it; keep freeform strings as typed.
        const trimmed = newQuantity.trim();
        const parsed = parseQuantity(trimmed);
        const quantityToSave = parsed ? formatQuantity(parsed.value, parsed.unit) : (trimmed || undefined);

        setAllItems(prev =>
            prev.map(i =>
                i.id === selectedItem.id
                    ? { ...i, quantity: quantityToSave }
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
     {/* Same three choices as the FAB, in the same order and wording. A lone
         "+ Add Meal" meant the empty state quietly offered less than the button
         in the corner, and silently picked one of the three for you. */}
     { sortedMeals.length == 0 &&
      <View style={styles.emptyMealsContainer}>
        <Text style={styles.emptyMealsText}>Let&apos;s get cooking!</Text>
        <View style={styles.emptyActions}>
          <TouchableOpacity style={styles.emptyAction} onPress={onAddMeal}>
            <Ionicons name="add-outline" size={22} color={primary} />
            <Text style={styles.emptyActionText}>New Meal</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.emptyAction} onPress={onAddFromCookbook}>
            <Ionicons name="book-outline" size={22} color={primary} />
            <Text style={styles.emptyActionText}>From Cookbook</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.emptyAction} onPress={onSuggestMeal}>
            <Ionicons name="sparkles" size={22} color={primary} />
            <Text style={styles.emptyActionText}>Suggest Meal</Text>
          </TouchableOpacity>
        </View>
      </View>
     }
     { sortedMeals.length > 0 && 
      <FlatList
        data={sortedMeals}
        keyExtractor={(item) => item.id}
        // A ScrollView left on the default 'never' captures the first tap
        // anywhere outside a focused input, spends it on dismissing the
        // keyboard, and never passes it to the child. An ingredient's ✕ only
        // exists while that ingredient's input is focused, so every press on it
        // was being eaten here before it reached the button. 'handled' still
        // dismisses the keyboard for taps no child claims.
        keyboardShouldPersistTaps="handled"
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
  emptyActions: { marginTop: 16, gap: 10, alignSelf: 'stretch', paddingHorizontal: 40 },
  emptyAction: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#fff', borderRadius: 25, paddingVertical: 12, paddingHorizontal: 18,
    borderWidth: 1, borderColor: '#e9ecef',
  },
  emptyActionText: { fontSize: 16, fontWeight: '600', color: primary },
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