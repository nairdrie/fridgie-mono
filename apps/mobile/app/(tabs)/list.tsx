import AddEditRecipeModal from '@/components/AddEditRecipeModal';
import MealPlanView from '@/components/MealPlanView';
import MealSuggestionsModal from '@/components/MealSuggestionsModal';
import ViewRecipeModal from '@/components/ViewRecipeModal';
import { useLists } from '@/context/ListContext';
import { Item, List, ListView, Meal, Recipe } from '@/types/types';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LexoRank } from 'lexorank';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import uuid from 'react-native-uuid';
import { categorizeList, listenToList, scheduleMealRating, updateList } from '../../utils/api';


export default function ListScreen() {
  const { selectedList, isLoading, selectedGroup, selectedView } = useLists();
  
  const [meals, setMeals] = useState<Meal[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const [editingId, setEditingId] = useState<string>('');
  const [isCategorizing, setIsCategorizing] = useState(false);
  const [isKeyboardVisible, setKeyboardVisible] = useState(false);
  const inputRefs = useRef<Record<string, TextInput | null>>({});

  const [isSuggestionModalVisible, setSuggestionModalVisible] = useState(false);


  const [collapsedMeals, setCollapsedMeals] = useState<Record<string, boolean>>({});

  const [recipeToViewId, setRecipeToViewId] = useState<string | null>(null);
  const [recipeToEdit, setRecipeToEdit] = useState<Meal | null>(null);


  const dirtyUntilRef = useRef<number>(0);
  const markDirty = () => {
    const until = Date.now() + 1200; // tweak if you want a longer freeze
    dirtyUntilRef.current = until;
  };

  // EFFECT 1: Handles ALL incoming data (Initial Fetch + Real-time Updates)
  useEffect(() => {
    if (!selectedList || !selectedGroup) {
      setItems([]);
      setMeals([]);
      return;
    }

    const unsubscribe = listenToList(selectedGroup.id, selectedList.id, (list: List) => {
      if (!list) {
        console.warn(`Received null data for list ${selectedList.id}, ignoring update.`);
        return;
      }
      
      // ignore server echoes while the user is actively typing
      if (Date.now() < dirtyUntilRef.current) return;

      const rawItems = Array.isArray(list.items) ? list.items : [];
      const withOrder = rawItems
        .map((item: Item) => ({ ...item, listOrder: item.listOrder ?? LexoRank.middle().toString() }))
        .sort((a: Item, b: Item) => a.listOrder.localeCompare(b.listOrder));

      // optional: avoid pointless state updates (prevents cursor weirdness)
      setItems(prev => {
        const sameLength = prev.length === withOrder.length;
        const sameAll = sameLength && prev.every((p, i) =>
          p.id === withOrder[i].id &&
          p.text === withOrder[i].text &&
          p.checked === withOrder[i].checked &&
          p.listOrder === withOrder[i].listOrder &&
          p.isSection === withOrder[i].isSection
        );
        if (sameAll) return prev;

        if (withOrder.length === 0) {
          return [{
            id: uuid.v4() as string,
            text: '',
            checked: false,
            listOrder: LexoRank.middle().toString(),
            isSection: false,
          }];
        }
        return withOrder;
      });

      setMeals(Array.isArray(list.meals) ? list.meals : []);
    });

    return () => unsubscribe();
  }, [selectedList, selectedGroup]); // note: no need to depend on dirtyUntil now

  // EFFECT 2: Handles ALL outgoing data (Debounced Saving)
  useEffect(() => {
    if (!selectedList?.id || !selectedGroup) return;
    const timeout = setTimeout(() => {
      updateList(selectedGroup.id, selectedList.id, { items, meals: meals }).catch(console.error);
    }, 500);
    return () => clearTimeout(timeout);
  }, [items, meals, selectedList?.id, selectedGroup]);

  // whenever editingId (or items) changes, ensure focus
  useEffect(() => {
    if (!editingId) return;
    // next tick so the newly-rendered TextInput is mounted
    requestAnimationFrame(() => focusAtEnd(editingId));
  }, [editingId, items]);

  // useEffect to listen for keyboard events
  useEffect(() => {
    const keyboardDidShowListener = Keyboard.addListener(
      'keyboardDidShow',
      () => setKeyboardVisible(true)
    );
    const keyboardDidHideListener = Keyboard.addListener(
      'keyboardDidHide',
      () => setKeyboardVisible(false)
    );

    return () => {
      keyboardDidHideListener.remove();
      keyboardDidShowListener.remove();
    };
  }, []);


  useEffect(() => {
      const loadCollapsedState = async () => {
         try {
            const storedState = await AsyncStorage.getItem('collapsedMealState');
            if (storedState) {
               setCollapsedMeals(JSON.parse(storedState));
            }
         } catch (e) {
            console.error("Failed to load collapsed meal state.", e);
         }
      };
      loadCollapsedState();
   }, []);

   const handleRecipeSaved = (updatedMeal: Meal, newItems: Item[]) => {
    // Update the meal in the meals list
    setMeals(prevMeals =>
      prevMeals.map(meal => (meal.id === updatedMeal.id ? updatedMeal : meal))
    );

    // Remove old items for this meal and add the new ones, properly ranked
    setItems(currentItems => {
      const base = currentItems.filter(item => item.mealId !== updatedMeal.id);

      let lastRank = base.length > 0 ? LexoRank.parse(base[base.length - 1].listOrder) : LexoRank.middle();

      const rankedNewItems = newItems.map(item => {
        lastRank = lastRank.genNext();
        return { ...item, listOrder: lastRank.toString() };
      });

      const isSingleEmpty = base.length === 1 && (base[0].text ?? '') === '' && !base[0].isSection;
      return isSingleEmpty ? rankedNewItems : [...base, ...rankedNewItems];
    });

    markDirty();
  };

  const handleViewRecipe = (meal: Meal) => {
    if (!meal.recipeId) {
      Alert.alert("No Recipe", "A recipe has not been added for this meal yet.");
      return;
    }
    setRecipeToViewId(meal.recipeId);
  };

  const handleAddRecipe = (meal: Meal) => {
    setRecipeToEdit(meal);
  };

  const assignRef = useCallback((id: string) => (ref: TextInput | null) => { inputRefs.current[id] = ref; }, []);
  const updateItemText = (id: string, text: string) => { setItems(prev => prev.map(item => (item.id === id ? { ...item, text } : item))); markDirty(); };
  const toggleCheck = (id: string) => { setItems(prev => prev.map(item => (item.id === id ? { ...item, checked: !item.checked } : item))); markDirty(); };

  const focusAtEnd = (id: string) => {
    const ref = inputRefs.current[id];
    if (!ref) return;
    ref.focus?.();

    // place caret at end (RN quirk: do it on a tick)
    const len = (items.find(i => i.id === id)?.text || '').length;
    setTimeout(() => {
      // @ts-ignore - setNativeProps selection is supported on RN TextInput
      ref.setNativeProps?.({ selection: { start: len, end: len } });
    }, 0);
  };

  const handleAddMealsFromSuggestion = (newMeals: Meal[], newItemsFromModal: Item[]) => {
    setMeals(prev => [...prev, ...newMeals]);

    setItems(currentItems => {
      let lastRank =
        currentItems.length > 0 && currentItems[currentItems.length - 1].text !== ''
          ? LexoRank.parse(currentItems[currentItems.length - 1].listOrder)
          : LexoRank.middle();

      const rankedNewItems = newItemsFromModal.map(item => {
        lastRank = lastRank.genNext();
        return { ...item, listOrder: lastRank.toString() };
      });

      // Handle case where list is just a single empty placeholder
      const isSingleEmpty = currentItems.length === 1 && (currentItems[0].text ?? '') === '' && !currentItems[0].isSection;
      if (isSingleEmpty) {
        return rankedNewItems;
      }
      
      return [...currentItems, ...rankedNewItems];
    });

    markDirty();
  };

  const handleAddMeal = () => {
    if (!selectedGroup || !selectedList) return;
    
    const newMeal: Meal = {
      id: uuid.v4() as string,
      listId: selectedList.id,
      name: '', // Default name
      // dayOfWeek is optional and thus omitted
    };

    setMeals(prev => [...prev, newMeal]);
    setEditingId(newMeal.id);
    markDirty(); // Trigger debounced save
  };

  const handleEditRecipe = (recipe: Recipe) => {
    const meal = meals.find(m => m.recipeId === recipe.id);
    if (meal) {
        setRecipeToViewId(null); // Close view modal
        setRecipeToEdit(meal);   // Open edit modal
    }
  };

   

  const handleUpdateMeal = (mealId: string, updates: Partial<Meal>) => {
    setMeals(prev => prev.map(meal => (meal.id === mealId ? { ...meal, ...updates } : meal)));
    markDirty();

    if (updates.dayOfWeek && selectedList) {
      scheduleMealRating(mealId, selectedList.id, updates.dayOfWeek)
        .catch(console.error);
    }
  };
  
  const handleDeleteMeal = (mealId: string) => {
    setMeals(prev => prev.filter(meal => meal.id !== mealId));
    setItems(prev => prev.filter(item => item.mealId !== mealId)); // Also remove ingredients
    markDirty();
  };

   const addItemAfter = (id: string) => {
    // This function now only runs if there is already a selected list.
    if (!selectedList) return;
    
    const index = items.findIndex(i => i.id === id);
    if (index === -1) return;
    const current = LexoRank.parse(items[index].listOrder);
    const next = items[index + 1] ? LexoRank.parse(items[index + 1].listOrder) : current.genNext();
    const newItem: Item = { id: uuid.v4() as string, text: '', checked: false, listOrder: current.between(next).toString(), isSection: false };
    
    const updated = [...items];
    updated.splice(index + 1, 0, newItem);
    setItems(updated);
    setEditingId(newItem.id);
    markDirty();
    setTimeout(() => inputRefs.current[newItem.id]?.focus(), 50);
  };
  
  const reRankItems = (data: Item[]) => {
    let rank = LexoRank.middle();
    return data.map(item => { rank = rank.genNext(); return { ...item, order: rank.toString() }; });
  };

  const deleteItem = (id: string) => {
    const index = items.findIndex(i => i.id === id);
    if (index === -1) return;

    // This part remains the same
    if (items.length === 1) {
      const placeholderItem = {
        id: uuid.v4() as string,
        text: '',
        checked: false,
        listOrder: LexoRank.middle().toString(),
        isSection: false,
      };
      setItems([placeholderItem]);
      setEditingId(placeholderItem.id);
      markDirty();
      return;
    }

    delete inputRefs.current[id];
    const updated = items.filter(item => item.id !== id);
    setItems(updated);
    markDirty();

    if (isKeyboardVisible) {
      const nextFocusId = updated[Math.max(0, index - 1)]?.id;
      if (nextFocusId) {
        setEditingId(nextFocusId);
      }
    } else {
      setEditingId('');
    }
  };

  const handleAutoCategorize = async () => {
    if (!selectedGroup || !selectedList?.id) return;
    setIsCategorizing(true);
    markDirty();
    try {
      const newItems = await categorizeList(selectedGroup.id, selectedList.id);
      setItems(newItems);
      setEditingId('');
    } catch (err) {
      console.error('Auto-categorization failed', err);
    } finally {
      setIsCategorizing(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      const checkForPendingAction = async () => {
        try {
          const pendingAction = await AsyncStorage.getItem('pendingAction');

          if (pendingAction === 'suggest-meals') {
            await AsyncStorage.removeItem('pendingAction');
            setSuggestionModalVisible(true); 
          }
        } catch (e) {
          console.error("Failed to check for pending action:", e);
        }
      };

      checkForPendingAction();
    }, [])
  );

  const onToggleMealCollapse = async (mealId: string) => {
    const updatedStates = {
      ...collapsedMeals,
      [mealId]: !collapsedMeals[mealId]
    };
    setCollapsedMeals(updatedStates);
    try {
      await AsyncStorage.setItem('collapsedMealState', JSON.stringify(updatedStates));
    } catch (e) {
      console.error("Failed to save collapsed meal state.", e);
    }
  };

  const handleAddItem = (isSection=false) => {
    // This function now only runs if there is already a selected list.
    if (!selectedList) return;

    const lastOrder = items.length > 0 && items[items.length - 1].text !== '' ? LexoRank.parse(items[items.length - 1].listOrder) : LexoRank.middle();
    const newItem: Item = { id: uuid.v4() as string, text: '', checked: false, listOrder: lastOrder.genNext().toString(), isSection: isSection };
    const newItems = items.length === 1 && items[0].text === '' ? [newItem] : [...items, newItem];
    setItems(newItems);
    setEditingId(newItem.id);
    markDirty();
    setTimeout(() => inputRefs.current[newItem.id]?.focus(), 50);
  };

  const handleAddIngredientToMeal = (meal: Meal, ingredientText: string) => {
    if (!ingredientText) return;

    // 1. Create a new Item object, linking it to the meal
    const newItem: Item = {
      id: uuid.v4() as string,
      text: ingredientText,
      checked: false,
      listOrder: LexoRank.middle().toString(), // You'll want better ranking logic
      isSection: false,
      mealId: meal.id,
    };

    // 2. Add the new item to the single source of truth
    setItems(prevItems => [...prevItems, newItem]);

    markDirty(); // To trigger the debounced save
  };

  const renderItem = useCallback(({ item, drag }: RenderItemParams<Item>) => {
    const isEditing = item.id === editingId;
    return (
      <View style={styles.itemRow}>
        <Pressable onPressIn={drag} style={styles.dragHandle} hitSlop={10}>
          <Text style={styles.dragIcon}>≡</Text>
        </Pressable>
        {!item.isSection && (
          <TouchableOpacity style={styles.checkbox} onPress={() => toggleCheck(item.id)}>
            {item.checked ? <Text>✓</Text> : null}
          </TouchableOpacity>
        )}
        <TextInput
          ref={assignRef(item.id)}
          value={item.text}
          style={[styles.editInput, item.checked && styles.checked, item.isSection && styles.sectionText]}
          onChangeText={text => updateItemText(item.id, text)}
          onFocus={() => setEditingId(item.id)}
          onKeyPress={({ nativeEvent }) => {
            if (nativeEvent.key === 'Backspace' && item.text === '') {
              deleteItem(item.id);
            }
          }}
          onSubmitEditing={() => addItemAfter(item.id)}
          blurOnSubmit={false}
          returnKeyType="done"
        />
        {/* { item.mealId && (
          <Text style={ styles.mealName }>{meals.find(m => m.id === item.mealId)?.name || ''}</Text>
        )} */}
        {isEditing ? (
          <TouchableOpacity onPress={() => deleteItem(item.id)} style={styles.clearButton}>
            <Text style={styles.clearText}>✕</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.clearButton}>
            <Text style={styles.clearText}></Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }, [editingId, items]);
  
  if (isLoading) {
    return <View style={styles.container}><ActivityIndicator /></View>;
  }

  return (
    <>
    <StatusBar style="dark" />
    <View style={{ flex: 1, backgroundColor: '#fff' }}>
      {/* MAIN BODY */}
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={100}
      >
        { selectedView == ListView.GroceryList ? (
          <>
            {items.length === 0 && (
              <TouchableOpacity 
                  style={styles.addFirstIngredientButton}
                  onPress={() => handleAddItem()}>
                  <Text style={styles.addIngredientText}>+ Add Item</Text>
              </TouchableOpacity>
            )}
            <DraggableFlatList
              data={items}
              onDragEnd={({ data }) => { setItems(reRankItems(data)); markDirty(); }}
              keyExtractor={item => item.id}
              renderItem={renderItem}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              initialNumToRender={15}
              maxToRenderPerBatch={10}
              windowSize={10}
            />
          </>
          
        ) : (
          <MealPlanView
            meals={meals}
            items={items}
            setAllItems={setItems}
            onUpdateMeal={handleUpdateMeal}
            onDeleteMeal={handleDeleteMeal}
            onAddMeal={handleAddMeal}
            onViewRecipe={handleViewRecipe}
            onAddRecipe={handleAddRecipe}
            collapsedMeals={collapsedMeals}
            onToggleMealCollapse={onToggleMealCollapse}
            editingId={editingId}
            setEditingId={setEditingId}
            inputRefs={inputRefs}
            isKeyboardVisible={isKeyboardVisible}
            markDirty={markDirty}
          />
        )}
      </KeyboardAvoidingView>

      {/* BUTTON ROW */}
      <View style={styles.buttonRow}>
        {selectedView === ListView.MealPlan ? (
          <>
            <TouchableOpacity style={styles.actionButton} onPress={() => setSuggestionModalVisible(true)}>
              <Ionicons name="sparkles" size={18} color="#666" />
              <Text style={styles.buttonText}>Suggest Meals</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionButton} onPress={handleAddMeal}>
              <Ionicons name="add-circle" size={18} color="#666" />
              <Text style={styles.buttonText}>Add Meal</Text>
            </TouchableOpacity>
          </>
        ) : (
            <>
                <TouchableOpacity style={styles.actionButton} onPress={() => handleAddItem()}>
                  <Ionicons name="add-circle" size={18} color="#666" />
                  <Text style={styles.buttonText}>Item</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionButton} onPress={() => handleAddItem(true)}>
                  <Ionicons name="add-circle" size={18} color="#666" />
                  <Text style={styles.buttonText}>Section</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.actionButton, isCategorizing && { opacity: 0.5 }]}
                    onPress={handleAutoCategorize}
                    disabled={isCategorizing || !selectedList}
                >
                  <Ionicons name="sparkles" size={18} color="#666" />
                  <Text style={[styles.buttonText, { marginLeft: 8 }]}>{isCategorizing ? 'Categorizing…' : 'Categorize'}</Text>
                </TouchableOpacity>
            </>
          )}
        </View>
      </View>
      <ViewRecipeModal
        isVisible={!!recipeToViewId}
        onClose={() => setRecipeToViewId(null)}
        recipeId={recipeToViewId}
        onEdit={handleEditRecipe}
      />

      <AddEditRecipeModal
        isVisible={!!recipeToEdit}
        onClose={() => setRecipeToEdit(null)}
        mealForRecipe={recipeToEdit}
        onRecipeSave={handleRecipeSaved}
      />
      <MealSuggestionsModal
        isVisible={isSuggestionModalVisible}
        onClose={() => setSuggestionModalVisible(false)}
        onAddSelectedMeals={handleAddMealsFromSuggestion}
        listId={selectedList?.id ?? ''}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', padding: 10 },
  itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  dragHandle: { paddingHorizontal: 15, paddingVertical: 5 },
  dragIcon: { fontSize: 18, color: '#ccc' },
  checkbox: { width: 24, height: 24, marginRight: 10, borderWidth: 1, borderColor: '#999', alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  editInput: { fontSize: 16, flex: 1, paddingVertical: 0 },
  checked: { textDecorationLine: 'line-through', color: '#999' },
  clearButton: { paddingHorizontal: 8, paddingVertical: 4 },
  addFirstIngredientButton: { paddingVertical: 5, paddingLeft: 40 },
  addIngredientText: { color: '#007AFF', fontSize: 16 },
  clearText: { fontSize: 16, color: '#999' },
  sectionText: { fontWeight: 'bold', fontSize: 18 },
  buttonRow: { flexDirection: 'row', justifyContent: 'space-around', gap: 8, padding: 16, borderTopWidth: 1, borderColor: '#eee', backgroundColor: '#fff' },
  actionButton: { paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: '#ccc', borderRadius: 20, flexDirection:'row', alignItems:'center', justifyContent:'center', backgroundColor: '#f9f9f9' },
  buttonText: { fontSize: 16, color: '#444', marginLeft: 5 },
});
