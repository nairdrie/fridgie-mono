import AddEditRecipeModal from '@/components/AddEditRecipeModal';
import MealPlanView from '@/components/MealPlanView';
import MealSuggestionsModal from '@/components/MealSuggestionsModal';
import ViewRecipeModal from '@/components/ViewRecipeModal';
import { useLists } from '@/context/ListContext';
import { Item, List, ListView, Meal, Recipe } from '@/types/types';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useRouter } from 'expo-router';
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
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import uuid from 'react-native-uuid';
import { categorizeList, listenToList, scheduleMealRating, updateList } from '../../utils/api';


export default function ListScreen() {
    const router = useRouter();
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

    const [isFabMenuOpen, setIsFabMenuOpen] = useState(false);
    const fabAnimation = useSharedValue(0);


    const dirtyUntilRef = useRef<number>(0);
    const markDirty = () => {
        const until = Date.now() + 1200; // tweak if you want a longer freeze
        dirtyUntilRef.current = until;
    };

    // Animate FAB menu
    useEffect(() => {
        fabAnimation.value = withTiming(isFabMenuOpen ? 1 : 0, { duration: 250 });
    }, [isFabMenuOpen]);


    const fabRotation = useAnimatedStyle(() => ({
        transform: [{ rotate: `${fabAnimation.value * 45}deg` }],
    }));

    const backdropStyle = useAnimatedStyle(() => ({
        opacity: fabAnimation.value,
    }));

    // Define all animated styles unconditionally at the top level
    const secondaryFabStyle = (index: number) => useAnimatedStyle(() => {
        // Animate upwards. 70 is base offset, 65 for each subsequent button.
        const translateY = fabAnimation.value * -(80 + (index * 65));
        return {
            transform: [{ translateY }],
            opacity: fabAnimation.value,
        };
    });

    const fabStyle0 = secondaryFabStyle(0);
    const fabStyle1 = secondaryFabStyle(1);
    const fabStyle2 = secondaryFabStyle(2);


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
        };

        setMeals(prev => [...prev, newMeal]);
        setEditingId(newMeal.id);
        markDirty();
    };

    const handleEditRecipe = (recipe: Recipe) => {
        const meal = meals.find(m => m.recipeId === recipe.id);
        if (meal) {
            setRecipeToViewId(null);
            setRecipeToEdit(meal);
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
        setItems(prev => prev.filter(item => item.mealId !== mealId));
        markDirty();
    };

    const addItemAfter = (id: string) => {
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

    useFocusEffect(
        useCallback(() => {
          const checkForPastUnratedMeals = async () => {
            if (!meals.length || !selectedList) {
              return;
            }
    
            try {
              const ratedMealsRaw = await AsyncStorage.getItem('ratedMeals');
              const ratedMealIds = ratedMealsRaw ? JSON.parse(ratedMealsRaw) : {};
    
              const today = new Date();
              today.setHours(0, 0, 0, 0);
    
              const unratedPastMeals = meals.filter(meal => {
                if (!meal.dayOfWeek || !meal.recipeId || ratedMealIds[meal.id]) {
                  return false;
                }
    
                const weekStartDate = new Date(selectedList.weekStart);
                const dayIndex = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(meal.dayOfWeek);
                
                const mealDate = new Date(weekStartDate.getTime());
                mealDate.setDate(weekStartDate.getDate() + dayIndex);
                
                return mealDate < today;
              });
    
              if (unratedPastMeals.length > 0) {
                const mealToRate = unratedPastMeals.sort((a, b) => {
                    const dateA = new Date(selectedList.weekStart);
                    dateA.setDate(dateA.getDate() + ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(a.dayOfWeek!));
                    
                    const dateB = new Date(selectedList.weekStart);
                    dateB.setDate(dateB.getDate() + ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(b.dayOfWeek!));
    
                    return dateB.getTime() - dateA.getTime();
                })[0];
    
                router.push({
                  pathname: '/rate-meal',
                  params: { recipeId: mealToRate.recipeId, mealId: mealToRate.id },
                });
              }
            } catch (error) {
              console.error("Failed to check for unrated meals:", error);
            }
          };
    
          const timer = setTimeout(checkForPastUnratedMeals, 1000);
    
          return () => clearTimeout(timer);
        }, [meals, selectedList, router])
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
        if (!selectedList) return;

        const lastOrder = items.length > 0 && items[items.length - 1].text !== '' ? LexoRank.parse(items[items.length - 1].listOrder) : LexoRank.middle();
        const newItem: Item = { id: uuid.v4() as string, text: '', checked: false, listOrder: lastOrder.genNext().toString(), isSection: isSection };
        const newItems = items.length === 1 && items[0].text === '' ? [newItem] : [...items, newItem];
        setItems(newItems);
        setEditingId(newItem.id);
        markDirty();
        setTimeout(() => inputRefs.current[newItem.id]?.focus(), 50);
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
            <KeyboardAvoidingView
                style={styles.container}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={100}
            >
                { selectedView == ListView.GroceryList ? (
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
                        ListEmptyComponent={(
                            <View style={styles.emptyListComponent}>
                                <Text style={styles.emptyListText}>Your list is empty.</Text>
                                <Text style={styles.emptyListSubText}>Tap the '+' to add an item.</Text>
                            </View>
                        )}
                    />
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

            {isFabMenuOpen && (
                <Pressable style={styles.backdrop} onPress={() => setIsFabMenuOpen(false)} />
            )}

            <View style={styles.fabContainer}>
                {selectedView === ListView.MealPlan ? (
                    <>
                        <Animated.View style={[styles.secondaryFabContainer, fabStyle1]}>
                            <TouchableOpacity style={styles.secondaryButton} onPress={() => { setSuggestionModalVisible(true); setIsFabMenuOpen(false); }}>
                                <Ionicons name="sparkles" size={20} color="#333" style={styles.secondaryButtonIcon}/>
                                <Text style={styles.secondaryButtonText}>Suggest</Text>
                            </TouchableOpacity>
                        </Animated.View>
                        <Animated.View style={[styles.secondaryFabContainer, fabStyle0]}>
                             <TouchableOpacity style={styles.secondaryButton} onPress={() => { handleAddMeal(); setIsFabMenuOpen(false); }}>
                                 <Ionicons name="add-outline" size={20} color="#333" style={styles.secondaryButtonIcon}/>
                                 <Text style={styles.secondaryButtonText}>Meal</Text>
                             </TouchableOpacity>
                        </Animated.View>
                    </>
                ) : (
                    <>
                         <Animated.View style={[styles.secondaryFabContainer, fabStyle2]}>
                            <TouchableOpacity style={styles.secondaryButton} onPress={() => { handleAutoCategorize(); setIsFabMenuOpen(false); }} disabled={isCategorizing}>
                                <Ionicons name="sparkles" size={20} color="#333" style={styles.secondaryButtonIcon}/>
                                <Text style={styles.secondaryButtonText}>Categorize</Text>
                            </TouchableOpacity>
                         </Animated.View>
                         <Animated.View style={[styles.secondaryFabContainer, fabStyle1]}>
                             <TouchableOpacity style={styles.secondaryButton} onPress={() => { handleAddItem(true); setIsFabMenuOpen(false); }}>
                                <Ionicons name="reorder-two-outline" size={20} color="#333" style={styles.secondaryButtonIcon}/>
                                <Text style={styles.secondaryButtonText}>Category</Text>
                             </TouchableOpacity>
                         </Animated.View>
                         <Animated.View style={[styles.secondaryFabContainer, fabStyle0]}>
                             <TouchableOpacity style={styles.secondaryButton} onPress={() => { handleAddItem(); setIsFabMenuOpen(false); }}>
                                <Ionicons name="add-outline" size={20} color="#333" style={styles.secondaryButtonIcon}/>
                                <Text style={styles.secondaryButtonText}>Item</Text>
                             </TouchableOpacity>
                         </Animated.View>
                    </>
                )}
                 <TouchableOpacity style={styles.fab} onPress={() => setIsFabMenuOpen(prev => !prev)}>
                     <Animated.View style={fabRotation}>
                         <Ionicons name="add" size={32} color="white" />
                     </Animated.View>
                 </TouchableOpacity>
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
        </View>
        </>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#fff' },
    itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
    dragHandle: { paddingHorizontal: 15, paddingVertical: 5 },
    dragIcon: { fontSize: 18, color: '#ccc' },
    checkbox: { width: 24, height: 24, marginRight: 10, borderWidth: 1, borderColor: '#999', alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
    editInput: { fontSize: 16, flex: 1, paddingVertical: 0 },
    checked: { textDecorationLine: 'line-through', color: '#999' },
    clearButton: { paddingHorizontal: 8, paddingVertical: 4 },
    clearText: { fontSize: 16, color: '#999' },
    sectionText: { fontWeight: 'bold', fontSize: 18 },
    emptyListComponent: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 100,
    },
    emptyListText: {
        fontSize: 18,
        color: '#888',
        fontWeight: '600'
    },
    emptyListSubText: {
        fontSize: 14,
        color: '#aaa',
        marginTop: 8,
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.2)',
    },
    fabContainer: {
        position: 'absolute',
        bottom: 30,
        right: 20,
        alignItems: 'flex-end',
    },
    fab: {
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: '#007AFF',
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
    },
    secondaryFabContainer: {
        position: 'absolute',
        alignItems: 'center',
        right: 6, // Align with the center of the main FAB
    },
    secondaryButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#fff',
        borderRadius: 25,
        paddingVertical: 10,
        paddingHorizontal: 15,
        marginBottom: 10,
        elevation: 6,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 3,
    },
    secondaryButtonIcon: {
        marginRight: 8,
    },
    secondaryButtonText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#333'
    },
});

