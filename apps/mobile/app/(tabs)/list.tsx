// TODO: Loading state while we get the group and lists

import MealPlanView from '@/components/MealPlanView';
import { useLists } from '@/context/ListContext';
import { Ingredient, Item, List, ListView, Meal, MealPreferences, Recipe } from '@/types/types';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useRouter } from 'expo-router';
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
import { ApiError, categorizeList, getMealPreferences, getMealSuggestions, importRecipeFromUrl, listenToList, scheduleMealRating, updateList } from '../../utils/api';


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

  const [collapsedMeals, setCollapsedMeals] = useState<Record<string, boolean>>({});

  const [vetoedMeals, setVetoedMeals] = useState<string[]>([]);

  const [suggestionModalStep, setSuggestionModalStep] = useState<'confirm' | 'loading' | 'results'>('confirm');
  const [mealPreferences, setMealPreferences] = useState<MealPreferences | null>(null);


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
      // increment the indexref until the end then stop.
      if (loadingMessageIndexRef.current >= goofyLoadingMessages.length) {
        clearInterval(intervalId);
        return;
      }
  
      loadingMessageIndexRef.current = (loadingMessageIndexRef.current + 1) % goofyLoadingMessages.length;
      
      setLoadingMessage(goofyLoadingMessages[loadingMessageIndexRef.current]);
    }, 4000); // Change message every 2.5 seconds
  
    // Cleanup function to clear the interval when loading stops or the component unmounts
    return () => clearInterval(intervalId);
  }, [isSuggesting]); // This effect specifically runs when `isSuggesting` changes

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

  // Normalize & clean
  const normIngredients = (editingRecipe.ingredients || []).map((i: any) =>
    typeof i === 'string' ? { name: i, quantity: '' } : i
  );

  const cleanedRecipe: Recipe = {
    ...editingRecipe,
    ingredients: normIngredients.filter(i => (i.name ?? '').trim() !== ''),
    instructions: (editingRecipe.instructions || []).filter(i => (i ?? '').trim() !== ''),
  };

  const mealId = mealForRecipeEdit.id;

  // Update meal name/recipe
  setMeals(prevMeals =>
    prevMeals.map(meal =>
      meal.id === mealId ? { ...meal, recipe: cleanedRecipe, name: cleanedRecipe.name } : meal
    )
  );

  // Build ingredient items using the *current* list inside the updater
  setItems(currentItems => {
    // 1) Remove any previous items tied to this meal
    const base = currentItems.filter(item => item.mealId !== mealId);

    // 2) Seed lastRank from base
    let lastRank =
      base.length > 0 && base[base.length - 1].text !== ''
        ? LexoRank.parse(base[base.length - 1].listOrder)
        : LexoRank.middle();

    // 3) Map ingredients -> items with proper ranking
    const newItemsForRecipe: Item[] = cleanedRecipe.ingredients.map(ingredient => {
      lastRank = lastRank.genNext();
      return {
        id: uuid.v4() as string,
        text: ingredient.name.trim(),
        checked: false,
        listOrder: lastRank.toString(),
        isSection: false,
        mealId
      };
    });

    // 4) Replace the single empty placeholder if present
    const isSingleEmpty =
      base.length === 1 && (base[0].text ?? '') === '' && !base[0].isSection;

    return isSingleEmpty ? newItemsForRecipe : [...base, ...newItemsForRecipe];
  });

  markDirty();

  // Cleanup
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

   const handleRerollSuggestions = async () => {
    if (isSuggesting) return;

    // Add the current suggestions to the list of vetoed meals for this session
    const currentTitles = mealSuggestions.map(s => s.name);
    const newVetoedList = [...vetoedMeals, ...currentTitles];
    setVetoedMeals(newVetoedList);
    
    // Set loading state and clear selections
    setIsSuggesting(true);
    setSelectedSuggestions({});
    setMealSuggestions([]);

    try {
      // Call the API, passing the cumulative list of vetoed titles
      const suggestionsFromApi = await getMealSuggestions(newVetoedList);
      const suggestionsWithId = suggestionsFromApi.map(suggestion => ({
        ...suggestion,
        id: uuid.v4() as string,
      }));
      setMealSuggestions(suggestionsWithId);
    } catch (error) {
      console.error('An unexpected error occurred during reroll:', error);
      // Optionally close the modal or show an error message within it
      setSuggestionModalVisible(false);
    } finally {
      setIsSuggesting(false);
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

  const handleOpenSuggestionFlow = async () => {
    setSuggestionModalVisible(true);
    setSuggestionModalStep('loading'); // Show loading spinner while fetching prefs
    setMealPreferences(null);
    setIsSuggesting(false);

    try {
      const prefs = await getMealPreferences();
      setMealPreferences(prefs);
      setSuggestionModalStep('confirm'); // Move to the confirmation step
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setSuggestionModalVisible(false);
        await AsyncStorage.setItem('pendingAction', 'suggest-meals');
        router.navigate('/meal-preferences');
      } else {
        console.error('An unexpected error occurred while fetching preferences:', error);
        setSuggestionModalVisible(false);
        Alert.alert("Error", "Could not load your meal preferences. Please try again.");
      }
    }
  };

  // This function runs when the user confirms their preferences.
  const handleConfirmAndSuggest = async () => {
    console.log("HANDLE CONFIRM AND SUGGEST")
    setSuggestionModalStep('loading');
    setIsSuggesting(true); // This controls the goofy messages
    setMealSuggestions([]);
    setSelectedSuggestions({});

    try {
      const suggestionsFromApi = await getMealSuggestions();
      const suggestionsWithId = suggestionsFromApi.map(suggestion => ({
        ...suggestion,
        id: uuid.v4() as string,
      }));
      setMealSuggestions(suggestionsWithId);
      setSuggestionModalStep('results');
    } catch (error) {
      console.error('An unexpected error occurred during suggestion:', error);
      setSuggestionModalVisible(false);
      Alert.alert("Error", "Could not get meal suggestions. Please try again.");
    } finally {
      setIsSuggesting(false);
    }
  };

  // New handler for the "Edit Preferences" button
  const handleEditPreferences = async () => {
    setSuggestionModalVisible(false);
    await AsyncStorage.setItem('pendingAction', 'suggest-meals');
    router.navigate('/meal-preferences');
  };


  const toggleSuggestionSelection = (recipeId: string) => {
    setSelectedSuggestions((prev) => ({
      ...prev,
      [recipeId]: !prev[recipeId],
    }));
  };

  useFocusEffect(
    useCallback(() => {
      const checkForPendingAction = async () => {
        try {
          const pendingAction = await AsyncStorage.getItem('pendingAction');

          if (pendingAction === 'suggest-meals') {
            await AsyncStorage.removeItem('pendingAction');
            handleOpenSuggestionFlow();
          }
        } catch (e) {
          console.error("Failed to check for pending action:", e);
        }
      };

      checkForPendingAction();
    }, [])
  );

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
          recipe: recipe, 
        };
        newMeals.push(newMeal);

        // 2. Create new Items for its ingredients
        for (const ingredient of recipe.ingredients) {
          lastRank = lastRank.genNext();
          const newItem: Item = {
            id: uuid.v4() as string,
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

  const selectedCount = Object.values(selectedSuggestions).filter(Boolean).length;

  return (
    <>
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
            <TouchableOpacity style={styles.actionButton} onPress={handleOpenSuggestionFlow}>
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
          {suggestionModalStep === 'loading' && (
            <View style={styles.suggestionLoadingContainer}>
              <ActivityIndicator size="large" />
              <Text style={styles.suggestionLoadingText}>
                {isSuggesting ? loadingMessage : 'Fetching your preferences...'}
              </Text>
            </View>
          )}

          {suggestionModalStep === 'confirm' && mealPreferences && (
            <>
              <Text style={styles.modalTitle}>Your Meal Profile</Text>
              <ScrollView>
                <View style={styles.prefsSummaryContainer}>
                  <Text style={styles.prefsSummaryTitle}>Dietary Needs</Text>
                  <Text style={styles.prefsSummaryText}>
                    {mealPreferences.dietaryNeeds?.join(', ') || 'None specified'}
                  </Text>

                  <Text style={styles.prefsSummaryTitle}>Cooking Styles</Text>
                  <Text style={styles.prefsSummaryText}>
                    {mealPreferences.cookingStyles?.join(', ') || 'None specified'}
                  </Text>

                  <Text style={styles.prefsSummaryTitle}>Cuisine Type</Text>
                  <Text style={styles.prefsSummaryText}>
                    {mealPreferences.cuisines?.join(', ') || 'None specified'}
                  </Text>

                    <Text style={styles.prefsSummaryTitle}>Disliked Ingredients</Text>
                  <Text style={styles.prefsSummaryText}>
                    {mealPreferences.dislikedIngredients || 'None specified'}
                  </Text>
                </View>
              </ScrollView>
              <TouchableOpacity style={styles.editPrefsButton} onPress={handleEditPreferences}>
                <Text style={styles.editPrefsButtonText}>Edit Preferences</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalButton} onPress={handleConfirmAndSuggest}>
                <Ionicons name="sparkles" size={18} color="#fff" style={{marginRight: 8}}/>
                <Text style={styles.modalButtonText}>Suggest Meals</Text>
              </TouchableOpacity>
            </>
          )}

          {suggestionModalStep === 'results' && (
            <>
              <Text style={styles.modalTitle}>Meal Suggestions</Text>
              <View style={styles.rerollButtonContainer}>
                <TouchableOpacity
                  style={styles.rerollButton}
                  onPress={handleRerollSuggestions}
                  disabled={isSuggesting}
                >
                  <Ionicons name="dice" size={18} color="white" />
                  <Text style={styles.rerollButtonText}>Re-roll</Text>
                </TouchableOpacity>
              </View>
            
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
                        <Text style={styles.suggestionDescription}>{item.description}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                }}
              />
              <TouchableOpacity
                style={[styles.modalButton, selectedCount === 0 && styles.modalButtonDisabled]}
                onPress={handleAddSelectedMeals}
                disabled={selectedCount === 0}
              >
                <Text style={styles.modalButtonText}>
                  {selectedCount > 0 ? `Add ${selectedCount} Selected Meal(s)` : 'Select a Meal'}
                </Text>
              </TouchableOpacity>
            </> 
          )}
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
      <SafeAreaView style={styles.modalContainer}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          {/* --- Header --- */}
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Add a Recipe</Text>
            <TouchableOpacity onPress={() => setAddRecipeModalVisible(false)}>
              <Ionicons name="close-circle" size={28} color="#aaa" />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.modalScrollView}
            contentContainerStyle={styles.modalScrollViewContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* --- Import Section --- */}
            <View style={styles.formSectionContainer}>
              <Text style={styles.formSectionTitle}>Import from URL</Text>
              <TextInput
                style={styles.formInput}
                placeholder="e.g., allrecipes.com/..."
                placeholderTextColor="#999"
                value={importUrl}
                onChangeText={setImportUrl}
                autoCapitalize="none"
                keyboardType="url"
              />
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  isImportingRecipe && styles.disabledButton,
                ]}
                onPress={handleImportRecipe}
                disabled={isImportingRecipe}
              >
                {isImportingRecipe ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryButtonText}>Import</Text>
                )}
              </TouchableOpacity>
            </View>

            {/* --- Main Form --- */}
            {editingRecipe && (
              <>
                {/* --- Name & Description --- */}
                <View style={styles.formSectionContainer}>
                  <TextInput
                    style={styles.recipeNameInput}
                    placeholder="Recipe Name"
                    placeholderTextColor="#999"
                    value={editingRecipe.name}
                    onChangeText={(val) => handleRecipeFieldChange('name', val)}
                  />
                  <TextInput
                    style={[styles.formInput, styles.descriptionInput]}
                    placeholder="A short, tasty description..."
                    placeholderTextColor="#999"
                    value={editingRecipe.description}
                    onChangeText={(val) =>
                      handleRecipeFieldChange('description', val)
                    }
                    multiline
                  />
                </View>

                {/* --- Ingredients --- */}
                <View style={styles.formSectionContainer}>
                  <Text style={styles.formSectionTitle}>Ingredients</Text>
                  {editingRecipe.ingredients.map((ing, index) => (
                    <View key={`ing-${index}`} style={styles.formRow}>
                      <TextInput
                        style={[styles.formInput, styles.quantityInput]}
                        placeholder="1 cup"
                        placeholderTextColor="#999"
                        value={ing.quantity}
                        onChangeText={(val) =>
                          handleIngredientChange(index, 'quantity', val)
                        }
                      />
                      <TextInput
                        style={[styles.formInput, styles.nameInput]}
                        placeholder="Flour"
                        placeholderTextColor="#999"
                        value={ing.name}
                        onChangeText={(val) =>
                          handleIngredientChange(index, 'name', val)
                        }
                      />
                      <TouchableOpacity
                        onPress={() => removeIngredientField(index)}
                        style={styles.deleteRowButton}
                      >
                        <Ionicons
                          name="remove-circle-outline"
                          size={24}
                          color="#EF4444"
                        />
                      </TouchableOpacity>
                    </View>
                  ))}
                  <TouchableOpacity
                    style={styles.addFieldButton}
                    onPress={addIngredientField}
                  >
                    <Ionicons name="add" size={20} color="#007AFF" />
                    <Text style={styles.addFieldButtonText}>Add Ingredient</Text>
                  </TouchableOpacity>
                </View>

                {/* --- Instructions --- */}
                <View style={styles.formSectionContainer}>
                  <Text style={styles.formSectionTitle}>Instructions</Text>
                  {editingRecipe.instructions.map((inst, index) => (
                    <View key={`inst-${index}`} style={styles.formRow}>
                      <Text style={styles.stepNumber}>{index + 1}.</Text>
                      <TextInput
                        style={[styles.formInput, styles.nameInput]}
                        placeholder="Mix the things..."
                        placeholderTextColor="#999"
                        value={inst}
                        onChangeText={(val) =>
                          handleInstructionChange(index, val)
                        }
                        multiline
                      />
                      <TouchableOpacity
                        onPress={() => removeInstructionField(index)}
                        style={styles.deleteRowButton}
                      >
                        <Ionicons
                          name="remove-circle-outline"
                          size={24}
                          color="#EF4444"
                        />
                      </TouchableOpacity>
                    </View>
                  ))}
                  <TouchableOpacity
                    style={styles.addFieldButton}
                    onPress={addInstructionField}
                  >
                    <Ionicons name="add" size={20} color="#007AFF" />
                    <Text style={styles.addFieldButtonText}>Add Step</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </ScrollView>

          {/* --- Footer --- */}
          <View style={styles.modalFooter}>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => setAddRecipeModalVisible(false)}
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={handleSaveRecipe}
            >
              <Text style={styles.primaryButtonText}>Save Recipe</Text>
            </TouchableOpacity>
          </View>
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
    flexDirection: 'row',
    justifyContent: 'center',
  },
  rerollButtonContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 10,
  },
  rerollButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 30,
    width: 'auto',
    alignItems: 'center',
    // marginTop: 10,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  rerollButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    marginLeft:5
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

    addRecipeContainer: {
        flex: 1,
    },

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
    color: 'black',
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
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#F7F7F7', // A slightly off-white background
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#EFEFEF',
  },
  addRecipemodalTitle: {
    fontSize: 22,
    fontWeight: '700',
  },
  modalScrollView: {
    flex: 1,
  },
  modalScrollViewContent: {
    padding: 16,
    paddingBottom: 100, // Extra space for footer
  },
  formSectionContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  formSectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  formInput: {
    color: '#222222',
    borderWidth: 1,
    borderColor: '#EFEFEF',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 12,
  },
  recipeNameInput: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
    borderBottomWidth: 1,
    borderColor: '#EFEFEF',
    paddingBottom: 8,
  },
  descriptionInput: {
    minHeight: 80,
    textAlignVertical: 'top', // For Android
  },
  addRecipeformRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  addRecipequantityInput: {
    flex: 0.3,
    marginRight: 8,
  },
  addRecipenameInput: {
    flex: 1,
  },
  stepNumber: {
    marginRight: 8,
    fontSize: 16,
    color: '#888',
  },
  deleteRowButton: {
    padding: 4,
    marginLeft: 8,
  },
  addFieldButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 8,
  },
  addFieldButtonText: {
    color: '#007AFF',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 4,
  },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#EFEFEF',
    backgroundColor: '#FFFFFF',
  },
  primaryButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    minHeight: 50,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  secondaryButton: {
    backgroundColor: '#EFEFEF',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    flex: 1,
    marginRight: 10,
  },
  secondaryButtonText: {
    color: '#333',
    fontSize: 16,
    fontWeight: 'bold',
  },
  disabledButton: {
    opacity: 0.6,
  },
  prefsSummaryContainer: {
  backgroundColor: '#f7f7f7',
  borderRadius: 12,
  padding: 16,
  marginBottom: 16,
},
prefsSummaryTitle: {
  fontSize: 14,
  fontWeight: '600',
  color: '#888',
  textTransform: 'uppercase',
  marginBottom: 4,
},
prefsSummaryText: {
  fontSize: 16,
  color: '#333',
  marginBottom: 12,
  fontStyle: 'italic',
},
editPrefsButton: {
  padding: 15,
  borderRadius: 10,
  alignItems: 'center',
  marginTop: 10,
  backgroundColor: '#eef2f5',
},
editPrefsButtonText: {
  color: '#007AFF',
  fontSize: 16,
  fontWeight: 'bold',
},
});