// components/MealCard.tsx
import { Item, Meal } from "@/types/types";
import { mealPlaceholders } from "@/utils/mealPlaceholders";
import Ionicons from "@expo/vector-icons/Ionicons";
import { LexoRank } from "lexorank";
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutAnimation, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import uuid from 'react-native-uuid';

const DAYS: Meal['dayOfWeek'][] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface MealCardProps {
  meal: Meal;
  allItems: Item[];
  setAllItems: (callback: (prevItems: Item[]) => Item[]) => void;
  onUpdateMeal: (id: string, update: Partial<Meal>) => void;
  onDeleteMeal: (id: string) => void;
  // State and refs from parent screen
  editingId: string;
  setEditingId: React.Dispatch<React.SetStateAction<string>>;
  inputRefs: React.MutableRefObject<Record<string, TextInput | null>>;
  isKeyboardVisible: boolean;

  // Functions from parent screen
  markDirty: () => void;
}

export default function MealCard({
  meal,
  allItems,
  setAllItems,
  editingId,
  setEditingId,
  inputRefs,
  isKeyboardVisible,
  onUpdateMeal,
  onDeleteMeal,
  markDirty
}: MealCardProps) {
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  const [isDaySelectorVisible, setIsDaySelectorVisible] = useState(false);

  const daySelectorProgress = useSharedValue(0);
  
  const daySelectorAnimatedStyle = useAnimatedStyle(() => ({
    opacity: daySelectorProgress.value,
    transform: [{ translateX: (1 - daySelectorProgress.value) * -10 }],
    maxHeight: daySelectorProgress.value * 100, // Animate height
  }));

  useEffect(() => {
    daySelectorProgress.value = withTiming(isDaySelectorVisible ? 1 : 0, { duration: 300 });
  }, [isDaySelectorVisible]);

  const placeholder = useMemo(() => {
    return mealPlaceholders[Math.floor(Math.random() * mealPlaceholders.length)];
  }, []);
  

  // Memoize ingredients for this specific meal to avoid re-renders
  const ingredients = useMemo(
    () => allItems.filter(i => i.mealId === meal.id).sort((a, b) => (a.mealOrder && b.mealOrder) ? a.mealOrder.localeCompare(b.mealOrder) : 0),
    [allItems, meal.id]
  );

  // Assigns a ref to the inputRefs object from the parent
  const assignRef = useCallback((id: string) => (ref: TextInput | null) => {
    inputRefs.current[id] = ref;
  }, [inputRefs]);

  // ✅ 2. Add a handler for selecting/deselecting a day
  const handleDaySelect = (day: Meal['dayOfWeek']) => {
    const newDay = meal.dayOfWeek === day ? undefined : day;
    onUpdateMeal(meal.id, { dayOfWeek: newDay });
    // Trigger animation and hide the selector
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setIsDaySelectorVisible(false);
    markDirty();
  };

  const toggleDaySelector = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setIsDaySelectorVisible(prev => !prev);
  };

  // Handlers adapted from ListScreen to work within the context of a meal
  const handleUpdateIngredientText = (id: string, text: string) => {
    setAllItems(prev => prev.map(item => (item.id === id ? { ...item, text } : item)));
    markDirty();
  };

  const handleToggleCheck = (id: string) => {
    setAllItems(prev => prev.map(item => (item.id === id ? { ...item, checked: !item.checked } : item)));
    markDirty();
  };

  const handleDeleteIngredient = (id: string) => {
    const index = ingredients.findIndex(i => i.id === id);
    if (index === -1) return;

    // Remove the ref
    delete inputRefs.current[id];
    
    // Update the global items list
    setAllItems(prev => prev.filter(item => item.id !== id));
    markDirty();

    // Smart focus shift after deleting
    if (isKeyboardVisible) {
      const nextFocusId = ingredients[Math.max(0, index - 1)]?.id;
      if (nextFocusId) {
        setEditingId(nextFocusId);
      }
    } else {
      setEditingId('');
    }
  };

  const handleAddIngredient = (afterIndex: number | undefined) => {
    if(afterIndex === undefined) afterIndex = ingredients.length;
    // 1. Calculate the new mealOrder
    let mealRank: LexoRank;
    if (afterIndex < 0 || ingredients.length === 0) {
      // Case 1: Adding the very first ingredient
      mealRank = LexoRank.middle();
    } else {
      // Case 2: Adding after an existing ingredient
      const current = LexoRank.parse(ingredients[afterIndex].mealOrder!);
      const next = ingredients[afterIndex + 1] ? LexoRank.parse(ingredients[afterIndex + 1].mealOrder!) : current.genNext();
      mealRank = current.between(next);
    }
    
    // 2. Calculate the new listOrder (always at the end of the main list)
    const lastItem = allItems[allItems.length - 1];
    const listRank = lastItem ? LexoRank.parse(lastItem.listOrder).genNext() : LexoRank.middle();

    const newItem: Item = {
      id: uuid.v4() as string,
      text: '',
      checked: false,
      mealOrder: mealRank.toString(), // Assign mealOrder
      listOrder: listRank.toString(), // Assign listOrder
      isSection: false,
      mealId: meal.id,
    };

    // 3. Insert into the global list
    setAllItems(prev => [...prev, newItem]);
    setEditingId(newItem.id);
    markDirty();
  };
  
  const handleDragEnd = ({ data }: { data: Item[] }) => {
    let rank = LexoRank.middle();
    const reRankedIngredients = data.map(item => {
      rank = rank.genNext();
      return { ...item, mealOrder: rank.toString() }; // Update mealOrder
    });

    setAllItems(prevAllItems => {
        const otherItems = prevAllItems.filter(item => item.mealId !== meal.id);
        return [...otherItems, ...reRankedIngredients];
    });
    
    markDirty();
  };

  const renderIngredient = useCallback(({ item, drag, isActive, getIndex }: RenderItemParams<Item>) => {
    const isEditing = item.id === editingId;
    return (
      <View style={styles.itemRow}>
        <Pressable onPressIn={drag} style={styles.dragHandle} hitSlop={20} disabled={isActive}>
          <Text style={styles.dragIcon}>≡</Text>
        </Pressable>
        <TouchableOpacity style={styles.checkbox} onPress={() => handleToggleCheck(item.id)}>
          {item.checked && <Text>✓</Text>}
        </TouchableOpacity>
        <TextInput
          ref={assignRef(item.id)}
          value={item.text}
          style={[styles.editInput, item.checked && styles.checked]}
          onChangeText={text => handleUpdateIngredientText(item.id, text)}
          onFocus={() => setEditingId(item.id)}
          onKeyPress={({ nativeEvent }) => {
            if (nativeEvent.key === 'Backspace' && item.text === '') {
              handleDeleteIngredient(item.id);
            }
          }}
          onSubmitEditing={() => handleAddIngredient(getIndex())}
          blurOnSubmit={false}
          returnKeyType="next"
        />
        {isEditing && (
          <TouchableOpacity onPress={() => handleDeleteIngredient(item.id)} style={styles.clearButton}>
            <Text style={styles.clearText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }, [editingId, handleAddIngredient, handleDeleteIngredient, handleToggleCheck, handleUpdateIngredientText]);


  return (
    <View style={styles.mealCard}>
        {/* The main content is now wrapped in a View to group the selector and header */}
      <View style={styles.mainContent}>
        <View style={styles.dayPickerContainer}>
          <TouchableOpacity onPress={toggleDaySelector} style={styles.dayPickerCollapsed}>
            <Ionicons name="calendar-outline" size={18} color="#007AFF" />
            {meal.dayOfWeek && !isDaySelectorVisible && (
              <Text style={styles.selectedDayText}>{meal.dayOfWeek}</Text>
            )}
          </TouchableOpacity>

          {isDaySelectorVisible && (
            <Animated.View style={[styles.daySelectorContainer, daySelectorAnimatedStyle]}>
              {DAYS.map((day) => (
                <TouchableOpacity
                  key={day}
                  style={[styles.dayButton, meal.dayOfWeek === day && styles.dayButtonActive]}
                  onPress={() => handleDaySelect(day)}
                >
                  <Text style={[styles.dayText, meal.dayOfWeek === day && styles.dayTextActive]}>
                    {day?.charAt(0)}
                  </Text>
                </TouchableOpacity>
              ))}
            </Animated.View>
          )}
        </View>
        <View style={styles.mealHeader}>
            <TouchableOpacity onPress={() => setIsCollapsed(!isCollapsed)} style={styles.collapseButton}>
            <Text style={styles.collapseIcon}>{isCollapsed ? '▶' : '▼'}</Text>
            </TouchableOpacity>
            <TextInput
                ref={assignRef(meal.id)}
                style={styles.mealName}
                value={meal.name}
                onChangeText={(text) => onUpdateMeal(meal.id, { name: text })}
                placeholder={placeholder} 
            />
            <TouchableOpacity onPress={() => { onDeleteMeal(meal.id) }} style={styles.deleteButton}>
                <Ionicons name="trash" size={18} color="#db6767ff" /> 
            </TouchableOpacity>
        </View>
        </View>
      {!isCollapsed && (
        <View style={styles.ingredientListContainer}>
            <DraggableFlatList
                data={ingredients}
                onDragEnd={handleDragEnd}
                keyExtractor={(item) => item.id}
                renderItem={renderIngredient}
                // To prevent the parent FlatList from scrolling while dragging
                containerStyle={{ flex: 1 }}
                simultaneousHandlers={[]} 
            />
            {ingredients.length === 0 && (
                <TouchableOpacity 
                    style={styles.addFirstIngredientButton}
                    onPress={() => handleAddIngredient(-1)}>
                    <Text style={styles.addIngredientText}>+ Add Ingredient</Text>
                </TouchableOpacity>
            )}
        </View>
      )}
    </View>
  );
}


const styles = StyleSheet.create({
    mealCard: { backgroundColor: '#f9f9f9', padding: 12, borderRadius: 8, marginBottom: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2, elevation: 2 },
    mealHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    collapseButton: { padding: 5 },
    collapseIcon: { fontSize: 16 },
    mealName: { fontWeight: '600', fontSize: 18, flex: 1, marginHorizontal: 10 },
    deleteButton: { padding: 5 },
    settingsIcon: { fontSize: 20 },
    ingredientListContainer: { paddingTop: 10, borderTopWidth: 1, borderTopColor: '#eee', marginTop: 10 },
    mainContent: {
        // This new view helps group the day selector and the header
    },
    daySelectorContainer: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        paddingHorizontal: 20, // Give some space on the sides
    },
    dayButton: {
        width: 28,
        height: 28,
        borderRadius: 14,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#e9e9e9',
        marginHorizontal: 2
    },
    dayButtonActive: {
        backgroundColor: '#007AFF',
    },
    dayText: {
        fontWeight: '600',
        color: '#888',
    },
    dayTextActive: {
        color: '#fff',
    },
    // Styles ported from ListScreen for consistency
    itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5 },
    dragHandle: { width: 30, alignItems: 'center', justifyContent: 'center' },
    dragIcon: { fontSize: 18, color: '#aaa' },
    checkbox: { width: 24, height: 24, marginHorizontal: 10, borderWidth: 1, borderColor: '#ccc', borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
    editInput: { fontSize: 16, flex: 1, paddingVertical: 2 },
    checked: { textDecorationLine: 'line-through', color: '#999' },
    clearButton: { paddingHorizontal: 8 },
    clearText: { fontSize: 16, color: '#999' },
    addFirstIngredientButton: { paddingVertical: 5, paddingLeft: 40 },
    addIngredientText: { color: '#007AFF', fontSize: 16 },
    dayPickerContainer: {
      flexDirection: 'row',
      margin: 0,
      padding: 0,
      alignItems: 'center',
      height:30
    },
    dayPickerCollapsed: {
      flexDirection: 'row',
      alignItems: 'center'
    },
    selectedDayText: {
      marginLeft: 8,
      fontSize: 16,
      color: '#007AFF',
    }
});