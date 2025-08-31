// TODO: Loading state while we get the group and lists

import MealPlanView from '@/components/MealPlanView';
import { useLists } from '@/context/ListContext';
import { Ingredient, Item, List, ListView, Meal, Recipe } from '@/types/types';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { LexoRank } from 'lexorank';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import uuid from 'react-native-uuid';
import { ApiError, categorizeList, getMealSuggestions, importRecipeFromUrl, listenToList, updateList } from '../../utils/api';


export default function ListScreen() {
  const { selectedList, isLoading, selectedGroup, selectedView } = useLists();
  
  const [meals, setMeals] = useState<Meal[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const [editingId, setEditingId] = useState<string>('');
  const [isCategorizing, setIsCategorizing] = useState(false);
  const [dirtyUntil, setDirtyUntil] = useState<number>(0);
  const [isKeyboardVisible, setKeyboardVisible] = useState(false);
  const inputRefs = useRef<Record<string, TextInput | null>>({});

  const [isSuggestionModalVisible, setSuggestionModalVisible] = useState(false);
  const [mealSuggestions, setMealSuggestions] = useState<Recipe[]>([]);
  const [selectedSuggestions, setSelectedSuggestions] = useState<Record<string, boolean>>({});
  const [isSuggesting, setIsSuggesting] = useState(false);
  const goofyLoadingMessages = [
    'Consulting our chefs...',
    'Rummaging through the pantry...',
    'Asking grandma for her secret recipe...',
    'Warming up the oven...',
  ];
  const [loadingMessage, setLoadingMessage] = useState(goofyLoadingMessages[0]);
  const loadingMessageIndexRef = useRef(0);

  const router = useRouter();

  const [isRecipeModalVisible, setRecipeModalVisible] = useState(false);
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);

  const [isAddRecipeModalVisible, setAddRecipeModalVisible] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);
  const [mealForRecipeEdit, setMealForRecipeEdit] = useState<Meal | null>(null);
  const [importUrl, setImportUrl] = useState('');
  const [isImportingRecipe, setIsImportingRecipe] = useState(false);


  const dirtyUntilRef = useRef<number>(0);
  const markDirty = () => {
    const until = Date.now() + 1200; // tweak if you want a longer freeze
    dirtyUntilRef.current = until;
    setDirtyUntil(until); // keep your state if you read it elsewhere (optional)
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
    if (!isSuggesting) {
      return; // Do nothing if not loading
    }
  
    // Reset to the first message every time loading starts
    loadingMessageIndexRef.current = 0;
    setLoadingMessage(goofyLoadingMessages[0]);
  
    // Set up an interval to cycle through messages
    const intervalId = setInterval(() => {
      loadingMessageIndexRef.current = (loadingMessageIndexRef.current + 1) % goofyLoadingMessages.length;
      setLoadingMessage(goofyLoadingMessages[loadingMessageIndexRef.current]);
    }, 4000); // Change message every 2.5 seconds
  
    // Cleanup function to clear the interval when loading stops or the component unmounts
    return () => clearInterval(intervalId);
  }, [isSuggesting]); // This effect specifically runs when `isSuggesting` changes


  const assignRef = useCallback((id: string) => (ref: TextInput | null) => { inputRefs.current[id] = ref; }, []);
  const updateItemText = (id: string, text: string) => { setItems(prev => prev.map(item => (item.id === id ? { ...item, text } : item))); markDirty(); };
  const toggleCheck = (id: string) => { setItems(prev => prev.map(item => (item.id === id ? { ...item, checked: !item.checked } : item))); markDirty(); };


  const handleViewRecipe = (recipe: Recipe) => {
    setSelectedRecipe(recipe);
    setRecipeModalVisible(true);
  };

  const handleAddRecipe = (mealToEdit: Meal) => {
    setMealForRecipeEdit(mealToEdit);
    // Create a blank recipe structure to populate the form, pre-filling the name
    const blankRecipe: Recipe = {
      id: uuid.v4() as string,
      name: mealToEdit.name,
      description: '',
      ingredients: [{ name: '', quantity: '' }],
      instructions: [''],
    };
    setEditingRecipe(blankRecipe);
    setAddRecipeModalVisible(true);
    setImportUrl(''); // Clear any previous URL
  };

  const handleImportRecipe = async () => {
    if (!importUrl) return;
    Keyboard.dismiss();
    setIsImportingRecipe(true);
    try {
      const importedRecipe = await importRecipeFromUrl(importUrl);
      // Update the editing recipe state with the imported data
      setEditingRecipe(prev => ({ ...importedRecipe, id: prev!.id }));
    } catch (error) {
      console.error("Failed to import recipe", error);
      Alert.alert("Import Failed", "We couldn't get the recipe from that URL. Please check the link or enter it manually.");
    } finally {
      setIsImportingRecipe(false);
    }
  };

  const handleSaveRecipe = () => {
    if (!editingRecipe || !mealForRecipeEdit) return;

    // Filter out any empty ingredients or instructions before saving
    const cleanedRecipe = {
        ...editingRecipe,
        ingredients: editingRecipe.ingredients.filter(i => i.name.trim() !== ''),
        instructions: editingRecipe.instructions.filter(i => i.trim() !== ''),
    };

    const mealId = mealForRecipeEdit.id;

    // --- LOGIC TO CREATE NEW INGREDIENT ITEMS ---
    const newItemsForRecipe: Item[] = [];
    let lastRank =
      items.length > 0 && items[items.length - 1].text !== ''
        ? LexoRank.parse(items[items.length - 1].listOrder)
        : LexoRank.middle();

    for (const ingredient of cleanedRecipe.ingredients) {
        lastRank = lastRank.genNext();
        newItemsForRecipe.push({
            id: uuid.v4() as string,
            text: ingredient.name, // Just the name, as requested
            checked: false,
            listOrder: lastRank.toString(),
            isSection: false,
            mealId: mealId,
        });
    }
    
    // --- ATOMIC STATE UPDATE FOR ITEMS ---
    setItems((currentItems) => {
        // 1. Remove all old items that were linked to this meal
        const itemsWithoutOldRecipe = currentItems.filter(item => item.mealId !== mealId);
        // 2. Add the new items
        return [...itemsWithoutOldRecipe, ...newItemsForRecipe];
    });

    // --- UPDATE THE MEAL WITH THE ATTACHED RECIPE ---
    setMeals(prevMeals => 
      prevMeals.map(meal => 
        meal.id === mealId
          ? { ...meal, recipe: cleanedRecipe, name: cleanedRecipe.name }
          : meal
      )
    );
    markDirty();
    
    // --- CLEANUP ---
    setAddRecipeModalVisible(false);
    setEditingRecipe(null);
    setMealForRecipeEdit(null);
    setImportUrl('');
  };

  const handleRecipeFieldChange = (field: keyof Recipe, value: string) => {
    setEditingRecipe(prev => prev ? { ...prev, [field]: value } : null);
  };

  const handleIngredientChange = (index: number, field: keyof Ingredient, value: string) => {
    setEditingRecipe(prev => {
      if (!prev) return null;
      const newIngredients = [...prev.ingredients];
      newIngredients[index] = { ...newIngredients[index], [field]: value };
      return { ...prev, ingredients: newIngredients };
    });
  };

  const addIngredientField = () => {
    setEditingRecipe(prev => prev ? { ...prev, ingredients: [...prev.ingredients, { name: '', quantity: '' }] } : null);
  };

  const removeIngredientField = (index: number) => {
    setEditingRecipe(prev => prev ? { ...prev, ingredients: prev.ingredients.filter((_, i) => i !== index) } : null);
  };

  const handleInstructionChange = (index: number, value: string) => {
    setEditingRecipe(prev => {
      if (!prev) return null;
      const newInstructions = [...prev.instructions];
      newInstructions[index] = value;
      return { ...prev, instructions: newInstructions };
    });
  };

  const addInstructionField = () => {
    setEditingRecipe(prev => prev ? { ...prev, instructions: [...prev.instructions, ''] } : null);
  };

  const removeInstructionField = (index: number) => {
    setEditingRecipe(prev => prev ? { ...prev, instructions: prev.instructions.filter((_, i) => i !== index) } : null);
  };

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

  const handleAddMeal = () => {
    if (!selectedGroup || !selectedList) return;
    
    // Note: In a real app, the `createMeal` API call would happen here
    // For now, we'll create it client-side to demonstrate the UI.
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

  // ✅ NEW: Handler to update a meal
  const handleUpdateMeal = (mealId: string, updates: Partial<Meal>) => {
    setMeals(prev => prev.map(meal => (meal.id === mealId ? { ...meal, ...updates } : meal)));
    markDirty();
  };
  
  // ✅ NEW: Handler to delete a meal and its associated items
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

  const handleSuggestMeal = async () => {
    setSuggestionModalVisible(true);
    setIsSuggesting(true);
    setMealSuggestions([]);
    setSelectedSuggestions({});

    try {
      const suggestionsFromApi = await getMealSuggestions();
      
      // ✅ 1. FIX: Add a unique client-side ID to each suggestion for stable keys.
      const suggestionsWithId = suggestionsFromApi.map(suggestion => ({
        ...suggestion,
        id: uuid.v4() as string, 
      }));
      setMealSuggestions(suggestionsWithId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setSuggestionModalVisible(false); // Close modal before navigating
        router.navigate('/meal-preferences');
      } else {
        console.error('An unexpected error occurred:', error);
        // In a real app, you might want to show an error message in the modal
        setSuggestionModalVisible(false);
      }
    } finally {
      setIsSuggesting(false);
    }
  };

  // ✅ NEW: Toggles the selection state for a recipe in the modal.
  const toggleSuggestionSelection = (recipeId: string) => {
    setSelectedSuggestions((prev) => ({
      ...prev,
      [recipeId]: !prev[recipeId],
    }));
  };

  // ✅ NEW: Adds the selected meals and their ingredients to the main list.
  const handleAddSelectedMeals = () => {
    if (!selectedList) return;

    const newMeals: Meal[] = [];
    const newItems: Item[] = [];

    let lastRank =
      items.length > 0 && items[items.length - 1].text !== ''
        ? LexoRank.parse(items[items.length - 1].listOrder)
        : LexoRank.middle();

    for (const recipe of mealSuggestions) {
      if (selectedSuggestions[recipe.id]) {
        // 1. Create a new Meal and ATTACH the full recipe object to it
        const newMeal: Meal = {
          id: uuid.v4() as string,
          listId: selectedList.id,
          name: recipe.name,
          recipe: recipe, // ✅ Save the full recipe here
        };
        newMeals.push(newMeal);

        // 2. Create new Items for its ingredients
        for (const ingredient of recipe.ingredients) {
          lastRank = lastRank.genNext();
          const newItem: Item = {
            id: uuid.v4() as string,
            // ✅ CHANGE: Only use the ingredient name for the list item text
            text: ingredient.name,
            checked: false,
            listOrder: lastRank.toString(),
            isSection: false,
            mealId: newMeal.id,
          };
          newItems.push(newItem);
        }
      }
    }

    if (newMeals.length > 0) {
      setMeals((prev) => [...prev, ...newMeals]);
      setItems((prev) => {
        if (prev.length === 1 && prev[0].text === '') {
          return newItems;
        }
        return [...prev, ...newItems];
      });
      markDirty();
    }
    
    setSuggestionModalVisible(false);
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
      mealId: meal.id, // ✅ Link it!
    };

    // 2. Add the new item to the single source of truth
    setItems(prevItems => [...prevItems, newItem]);

    markDirty(); // To trigger the debounced save
  };

  const renderItem = ({ item, drag }: RenderItemParams<Item>) => {
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
  };
  
  if (isLoading) {
    return <View style={styles.container}><ActivityIndicator /></View>;
  }

  const selectedCount = Object.values(selectedSuggestions).filter(Boolean).length;

  return (
    <>
    <View style={{ flex: 1, backgroundColor: '#fff' }}>
      {/* ✅ SUGGESTION MODAL */}
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
            // ✅ Pass down the required props
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
            <TouchableOpacity style={styles.actionButton} onPress={handleSuggestMeal}>
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
    <View>
      <Modal
        animationType="slide"
        transparent={true}
        visible={isSuggestionModalVisible}
        onRequestClose={() => setSuggestionModalVisible(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setSuggestionModalVisible(false)} />
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>Meal Suggestions</Text>
          {isSuggesting ? (
            <View style={styles.suggestionLoadingContainer}>
                <ActivityIndicator size="large" />
                <Text style={styles.suggestionLoadingText}>
                  {loadingMessage}
                </Text>
            </View>
          ) : (
            <FlatList
              data={mealSuggestions}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => {
                const isSelected = !!selectedSuggestions[item.id];
                return (
                  <TouchableOpacity
                    style={[styles.suggestionItem, isSelected && styles.suggestionItemSelected]}
                    onPress={() => toggleSuggestionSelection(item.id)}
                  >
                    <View style={styles.suggestionCheckbox}>{isSelected && <Text>✓</Text>}</View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.suggestionName}>{item.name}</Text>
                      <Text style={styles.suggestionDescription}>
                        {item.description}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
          )}
          <TouchableOpacity
            style={[styles.modalButton, selectedCount === 0 && styles.modalButtonDisabled]}
            onPress={handleAddSelectedMeals}
            disabled={selectedCount === 0}
          >
            <Text style={styles.modalButtonText}>
              {selectedCount > 0 ? `Add ${selectedCount} Selected Meal(s)` : 'Select a Meal'}
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>
      <Modal
        animationType="slide"
        transparent={true}
        visible={isRecipeModalVisible}
        onRequestClose={() => setRecipeModalVisible(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setRecipeModalVisible(false)} />
        <View style={[styles.modalContent, {maxHeight: '85%'} ]}>
          {selectedRecipe && (
            <FlatList
              ListHeaderComponent={
                <>
                  <Text style={styles.recipeTitle}>{selectedRecipe.name}</Text>
                  <Text style={styles.recipeDescription}>{selectedRecipe.description}</Text>
                  
                  <Text style={styles.recipeSectionTitle}>Ingredients</Text>
                  {selectedRecipe.ingredients.map((ing, index) => (
                    <Text key={index} style={styles.recipeIngredient}>
                      • {ing.quantity} {ing.name}
                    </Text>
                  ))}
                  
                  <Text style={styles.recipeSectionTitle}>Instructions</Text>
                </>
              }
              data={selectedRecipe.instructions}
              keyExtractor={(_, index) => `instr-${index}`}
              renderItem={({ item, index }) => (
                <Text style={styles.recipeInstruction}>
                  {index + 1}. {item}
                </Text>
              )}
              ListFooterComponent={
                 <TouchableOpacity
                    style={styles.modalButton}
                    onPress={() => setRecipeModalVisible(false)}
                  >
                  <Text style={styles.modalButtonText}>Close</Text>
                </TouchableOpacity>
              }
            />
          )}
        </View>
      </Modal>
      <Modal
            animationType="slide"
            visible={isAddRecipeModalVisible}
            onRequestClose={() => setAddRecipeModalVisible(false)}
        >
          <SafeAreaView style={{ flex: 1 }}>
            <KeyboardAvoidingView 
                style={{ flex: 1 }} 
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
            <ScrollView
                style={styles.addRecipeContainer}
                contentContainerStyle={styles.addRecipeScrollViewContent}
                keyboardShouldPersistTaps="handled" // Improves keyboard interaction
            >
                <Text style={styles.modalTitle}>Add a Recipe</Text>

                {/* Import Section */}
                <View style={styles.importSection}>
                    <Text style={styles.recipeSectionTitle}>Import from URL</Text>
                    <TextInput
                        style={styles.urlInput}
                        placeholder="e.g., allrecipes.com/..."
                        value={importUrl}
                        onChangeText={setImportUrl}
                        autoCapitalize="none"
                        keyboardType="url"
                    />
                    <TouchableOpacity
                        style={[styles.modalButton, { opacity: isImportingRecipe ? 0.6 : 1 }]}
                        onPress={handleImportRecipe}
                        disabled={isImportingRecipe}
                    >
                        {isImportingRecipe ? (
                            <ActivityIndicator color="#fff" />
                        ) : (
                            <Text style={styles.modalButtonText}>Import Recipe</Text>
                        )}
                    </TouchableOpacity>
                </View>
                
                {/* The main form content */}
                {editingRecipe && (
                    <>
                        <TextInput
                            style={styles.recipeTitleInput}
                            placeholder="Recipe Name"
                            value={editingRecipe.name}
                            onChangeText={val => handleRecipeFieldChange('name', val)}
                        />
                        <TextInput
                            style={styles.recipeDescriptionInput}
                            placeholder="A short, tasty description..."
                            value={editingRecipe.description}
                            onChangeText={val => handleRecipeFieldChange('description', val)}
                            multiline
                        />

                        {/* Ingredients Form */}
                        <Text style={styles.recipeSectionTitle}>Ingredients</Text>
                        {editingRecipe.ingredients.map((ing, index) => (
                            <View key={`ing-${index}`} style={styles.formRow}>
                                <TextInput
                                    style={styles.quantityInput}
                                    placeholder="1 cup"
                                    value={ing.quantity}
                                    onChangeText={val => handleIngredientChange(index, 'quantity', val)}
                                />
                                <TextInput
                                    style={styles.nameInput}
                                    placeholder="Flour"
                                    value={ing.name}
                                    onChangeText={val => handleIngredientChange(index, 'name', val)}
                                />
                                <TouchableOpacity onPress={() => removeIngredientField(index)}>
                                    <Ionicons name="remove-circle-outline" size={24} color="red" />
                                </TouchableOpacity>
                            </View>
                        ))}
                        <TouchableOpacity style={styles.addButton} onPress={addIngredientField}>
                            <Text style={styles.addButtonText}>+ Add Ingredient</Text>
                        </TouchableOpacity>

                        {/* Instructions Form */}
                        <Text style={styles.recipeSectionTitle}>Instructions</Text>
                        {editingRecipe.instructions.map((inst, index) => (
                            <View key={`inst-${index}`} style={styles.formRow}>
                                <Text style={{marginRight: 8, fontSize: 16}}>{index + 1}.</Text>
                                <TextInput
                                    style={styles.nameInput}
                                    placeholder="Mix the things"
                                    value={inst}
                                    onChangeText={val => handleInstructionChange(index, val)}
                                    multiline
                                />
                                <TouchableOpacity onPress={() => removeInstructionField(index)}>
                                    <Ionicons name="remove-circle-outline" size={24} color="red" />
                                </TouchableOpacity>
                            </View>
                        ))}
                        <TouchableOpacity style={styles.addButton} onPress={addInstructionField}>
                            <Text style={styles.addButtonText}>+ Add Step</Text>
                        </TouchableOpacity>
                    </>
                )}

                {/* The footer with action buttons */}
                <View style={styles.addRecipeFooter}>
                    <TouchableOpacity
                        style={[styles.modalButton, { backgroundColor: '#555' }]}
                        onPress={() => setAddRecipeModalVisible(false)}
                    >
                        <Text style={styles.modalButtonText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.modalButton} onPress={handleSaveRecipe}>
                        <Text style={styles.modalButtonText}>Save Recipe</Text>
                    </TouchableOpacity>
                </View>
            </ScrollView>
          </KeyboardAvoidingView>
          </SafeAreaView>
        </Modal>
    </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', padding: 10 },
  itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  dragHandle: { width: 40, alignItems: 'center', justifyContent: 'center' },
  dragIcon: { fontSize: 18 },
  checkbox: { width: 24, height: 24, marginHorizontal: 10, borderWidth: 1, borderColor: '#999', alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  editInput: { fontSize: 16, flex: 1, paddingRight: 40, paddingVertical: 0, borderWidth: 0, borderColor: 'transparent' },
  checked: { textDecorationLine: 'line-through', color: '#999' },
  clearButton: { paddingHorizontal: 8, paddingVertical: 4 },
  clearText: { fontSize: 16, color: '#999', width: 15 },
  sectionText: { fontWeight: 'bold', fontSize: 16 },
  buttonRow: { flexDirection: 'row', justifyContent: 'flex-start', gap: 8, padding: 16, borderTopWidth: 1, borderColor: '#eee', backgroundColor: '#fff' },
  actionButton: { paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: '#ccc', borderRadius: 4, flexDirection:'row', alignItems:'center', justifyContent:'center' },
  buttonText: { fontSize: 16, color: '#444', marginLeft:5, fontWeight: 'bold'  },
  addFirstIngredientButton: { paddingVertical: 5, paddingLeft: 40 },
  addIngredientText: { color: '#007AFF', fontSize: 16 },
  mealName: {fontStyle: 'italic', color: 'grey', fontSize: 12, textAlign: 'right', paddingRight:20},
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalContent: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '75%',
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center',
  },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 15,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    marginBottom: 10,
  },
  suggestionItemSelected: {
    borderColor: '#007AFF',
    backgroundColor: '#f0f8ff',
  },
  suggestionCheckbox: {
    width: 24,
    height: 24,
    borderWidth: 1,
    borderColor: '#999',
    borderRadius: 4,
    marginRight: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suggestionName: {
    fontSize: 16,
    fontWeight: '600',
  },
  suggestionDescription: {
    fontSize: 14,
    color: '#666',
    marginTop: 4,
  },
  modalButton: {
    backgroundColor: '#007AFF',
    padding: 15,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 10,
  },
  modalButtonDisabled: {
    backgroundColor: '#ccc',
  },
  modalButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  suggestionLoadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 40,
  },
  suggestionLoadingText: {
    marginTop: 15,
    fontSize: 16,
    color: '#666',
    fontStyle: 'italic',
  },
  recipeTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    // textAlign: 'center',
    marginBottom: 10,
  },
  recipeDescription: {
    fontSize: 16,
    color: '#555',
    // textAlign: 'center',
    marginBottom: 20,
    fontStyle: 'italic',
  },
  recipeSectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginTop: 15,
    marginBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    paddingBottom: 5,
  },
  recipeIngredient: {
    fontSize: 16,
    lineHeight: 24,
    marginLeft: 10,
  },
  recipeInstruction: {
    fontSize: 16,
    lineHeight: 26,
    marginBottom: 10,
  },
  // ✅ MODIFIED: This now only handles flex behavior
    addRecipeContainer: {
        flex: 1,
    },
    // ✅ NEW: This style applies padding to the scrollable content area
    addRecipeScrollViewContent: {
        padding: 20,
        paddingBottom: 60, // Extra space at the bottom for buttons
    },

  importSection: {
    marginBottom: 20,
    padding: 15,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10
  },
  urlInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 10,
    borderRadius: 8,
    fontSize: 16,
    marginBottom: 10,
  },
  recipeTitleInput: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 10,
    borderBottomWidth: 1,
    borderColor: '#eee',
    paddingBottom: 5,
  },
  recipeDescriptionInput: {
    fontSize: 16,
    fontStyle: 'italic',
    color: '#555',
    marginBottom: 20,
    minHeight: 60,
  },
  formRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  quantityInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 10,
    borderRadius: 8,
    width: '30%',
    marginRight: 10,
  },
  nameInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 10,
    borderRadius: 8,
    flex: 1,
    marginRight: 10,
  },
  addButton: {
    alignSelf: 'flex-start',
    marginVertical: 10,
  },
  addButtonText: {
    color: '#007AFF',
    fontSize: 16,
  },
  addRecipeFooter: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 20,
  }
});