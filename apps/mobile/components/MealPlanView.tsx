// components/MealPlanView.tsx
import { Item, Meal } from "@/types/types";
import React, { useMemo, useState } from 'react';
import { SectionList, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

const DAYS_OF_WEEK: Meal['dayOfWeek'][] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface MealPlanViewProps {
  meals: Meal[];
  items: Item[];
  onAddMeal: (day: Meal['dayOfWeek']) => void;
  onAddIngredient: (meal: Meal, text: string) => void;
  // You would also pass in functions for updating/deleting meals and items
}

export default function MealPlanView({ meals, items, onAddMeal, onAddIngredient }: MealPlanViewProps) {
  // Local state for the text input of a new ingredient
  const [newIngredientText, setNewIngredientText] = useState<Record<string, string>>({});

  const sections = useMemo(() => {
    return DAYS_OF_WEEK.map(day => {
      const mealsForDay = meals.filter(meal => meal.dayOfWeek === day);
      return {
        title: day,
        data: mealsForDay,
      };
    });
  }, [meals, items]);

  const renderMeal = ({ item: meal }: { item: Meal }) => {
    const ingredients = items.filter(i => i.mealId === meal.id);
    return (
      <View style={styles.mealCard}>
        <Text style={styles.mealName}>{meal.name}</Text>
        {ingredients.map(ing => (
          <Text key={ing.id} style={styles.ingredientText}>- {ing.text}</Text>
        ))}
        <View style={styles.addIngredientContainer}>
          <TextInput
            style={styles.ingredientInput}
            placeholder="+ Add ingredient"
            value={newIngredientText[meal.id] || ''}
            onChangeText={(text) => setNewIngredientText(prev => ({ ...prev, [meal.id]: text }))}
            onSubmitEditing={() => {
              if (newIngredientText[meal.id]) {
                onAddIngredient(meal, newIngredientText[meal.id]);
                setNewIngredientText(prev => ({ ...prev, [meal.id]: '' })); // Clear input
              }
            }}
          />
        </View>
      </View>
    );
  };

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.id}
      renderItem={renderMeal}
      renderSectionHeader={({ section: { title, data } }) => (
        <View style={styles.dayHeader}>
          <Text style={styles.dayTitle}>{title}</Text>
          {data.length === 0 && (
            <TouchableOpacity onPress={() => onAddMeal(title as Meal['dayOfWeek'])}>
              <Text style={styles.addMealText}>+ Add Meal</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      renderSectionFooter={({ section: { title, data } }) => {
        // Show "Add another meal" button if there's at least one meal for the day
        if (data.length > 0) {
          return (
            <TouchableOpacity style={styles.addAnotherMealButton} onPress={() => onAddMeal(title as Meal['dayOfWeek'])}>
              <Text style={styles.addMealText}>+ Add Another Meal</Text>
            </TouchableOpacity>
          );
        }
        return null;
      }}
      contentContainerStyle={{ padding: 10 }}
      stickySectionHeadersEnabled={false}
    />
  );
}

const styles = StyleSheet.create({
  dayHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 15, marginBottom: 5 },
  dayTitle: { fontSize: 18, fontWeight: 'bold' },
  addMealText: { color: '#007AFF', fontSize: 14 },
  addAnotherMealButton: { alignSelf: 'flex-start', paddingVertical: 5 },
  mealCard: { backgroundColor: '#f9f9f9', padding: 12, borderRadius: 8, marginBottom: 10 },
  mealName: { fontWeight: '600', fontSize: 16, marginBottom: 5 },
  ingredientText: { color: '#333', marginLeft: 5 },
  addIngredientContainer: { marginTop: 8 },
  ingredientInput: { fontSize: 14, color: '#555', paddingVertical: 4 },
});