// ListScreen.tsx

import AddEditRecipeModal from '@/components/AddEditRecipeModal';
import GroceryListView from '@/components/GroceryListView'; // Import the new component
import MealPlanView from '@/components/MealPlanView';
import MealSuggestionsModal from '@/components/MealSuggestionsModal';
import ViewRecipeModal from '@/components/ViewRecipeModal';
import { useAuth } from '@/context/AuthContext';
import { useLists } from '@/context/ListContext';
import { Item, List, ListView, Meal, Recipe } from '@/types/types';
import { primary } from '@/utils/styles';
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
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import uuid from 'react-native-uuid';
import { addUserCookbookRecipe, categorizeList, getUserCookbook, listenToList, removeUserCookbookRecipe, scheduleMealRating, updateList } from '../../utils/api';

// TODO: need a loading indicator when categorizing
// TODO: if the user already categorized, adding a meal should also categorize

export default function HomeScreen() {
    const router = useRouter();
    const { selectedList, isLoading, selectedGroup, selectedView, allLists } = useLists();
    const { user } = useAuth();
    
    const [meals, setMeals] = useState<Meal[]>([]);
    const [items, setItems] = useState<Item[]>([]);
    const [sort, setSort] = useState<List['sort']>('custom');

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

    const [cookbookRecipeIds, setCookbookRecipeIds] = useState<Set<string>>(new Set());

    const hasCheckedForUnratedMeals = useRef(false);

    const [isFocused, setIsFocused] = useState(false);
    useFocusEffect(
        useCallback(() => {
            setIsFocused(true); // Screen is focused
            return () => {
                setIsFocused(false); // Screen is unfocused
            };
        }, [])
    );

    useEffect(() => {
        // 1. Directly command the animation to close. This is the key fix.
        fabAnimation.value = withTiming(0, { duration: 150 });
        // 2. Sync the React state to ensure consistency.
        setIsFabMenuOpen(false);
    }, [selectedView]);

    const dirtyUntilRef = useRef<number>(0);
    const markDirty = () => {
        const until = Date.now() + 1200;
        dirtyUntilRef.current = until;
    };

    // Animate FAB menu
    useEffect(() => {
        fabAnimation.value = withTiming(isFabMenuOpen ? 1 : 0, { duration: 250 });
    }, [isFabMenuOpen]);


    const fabRotation = useAnimatedStyle(() => ({
        transform: [{ rotate: `${fabAnimation.value * 45}deg` }],
    }));

    const secondaryFabStyle = (index: number) => useAnimatedStyle(() => {
        const translateY = fabAnimation.value * -(80 + (index * 65));
        return {
            transform: [{ translateY }],
            opacity: fabAnimation.value,
        };
    });

    const fabStyle0 = secondaryFabStyle(0);
    const fabStyle1 = secondaryFabStyle(1);


    // Handles ALL incoming data (Initial Fetch + Real-time Updates)
    useEffect(() => {
        if (!selectedList || !selectedGroup) {
            setItems([]);
            setMeals([]);
            return;
        }

        let unsubscribe: () => void;
        const setupListener = async () => {
            try {
                unsubscribe = await listenToList(selectedGroup.id, selectedList.id, (list: List) => {
                    if (!list) return;
                    if (Date.now() < dirtyUntilRef.current) return;
                    
                    const rawItems = Array.isArray(list.items) ? list.items : [];
                    const withOrder = rawItems
                        .map((item: Item) => ({ ...item, listOrder: item.listOrder ?? LexoRank.middle().toString() }))
                        .sort((a: Item, b: Item) => a.listOrder.localeCompare(b.listOrder));
                    
                    setItems(withOrder.length > 0 ? withOrder : [{ id: uuid.v4() as string, text: '', checked: false, listOrder: LexoRank.middle().toString(), isSection: false }]);
                    setMeals(Array.isArray(list.meals) ? list.meals : []);
                    setSort(list.sort || 'custom'); // Update sort state
                });
            } catch (error) {
                console.error("Failed to set up list listener:", error);
            }
        };
        setupListener();
        return () => {
            if (unsubscribe) unsubscribe();
        };
    }, [selectedList, selectedGroup]);

    // Handles ALL outgoing data (Debounced Saving)
     useEffect(() => {
        if (!selectedList?.id || !selectedGroup) return;
        const timeout = setTimeout(() => {
            updateList(selectedGroup.id, selectedList.id, { items, meals, sort }).catch(console.error);
        }, 500);
        return () => clearTimeout(timeout);
    }, [items, meals, sort, selectedList?.id, selectedGroup]);

    const focusAtEnd = (id: string) => {
        const ref = inputRefs.current[id];
        if (!ref) return;
        ref.focus?.();

        const len = (items.find(i => i.id === id)?.text || '').length;
        setTimeout(() => {
            // @ts-ignore
            ref.setNativeProps?.({ selection: { start: len, end: len } });
        }, 0);
    };

    useEffect(() => {
        if (!editingId) return;
        requestAnimationFrame(() => focusAtEnd(editingId));
    }, [editingId, items]);

    useEffect(() => {
        const keyboardDidShowListener = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
        const keyboardDidHideListener = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
        return () => {
            keyboardDidHideListener.remove();
            keyboardDidShowListener.remove();
        };
    }, []);

    useFocusEffect(
        useCallback(() => {
            const fetchCookbook = async () => {
                try {
                    if(!user) return;
                    const cookbookRecipes = await getUserCookbook(user.uid);
                    const recipeIds = new Set(cookbookRecipes.map(r => r.id));
                    setCookbookRecipeIds(recipeIds);
                } catch (error) {
                    console.error("Failed to fetch user cookbook:", error);
                }
            };
            fetchCookbook();
        }, [])
    );

    useEffect(() => {
        const loadCollapsedState = async () => {
            try {
                const storedState = await AsyncStorage.getItem('collapsedMealState');
                if (storedState) setCollapsedMeals(JSON.parse(storedState));
            } catch (e) {
                console.error("Failed to load collapsed meal state.", e);
            }
        };
        loadCollapsedState();
    }, []);

    const handleRecipeSaved = (updatedMeal: Meal, newItems: Item[]) => {
        setMeals(prevMeals => prevMeals.map(meal => (meal.id === updatedMeal.id ? updatedMeal : meal)));
        
        // Add new items to the list
        setItems(currentItems => {
            const base = currentItems.filter(item => item.mealId !== updatedMeal.id);
            const allNewItems = [...base, ...newItems].filter(i => (i.text ?? '').trim() !== '' || i.isSection);
            return allNewItems;
        });
        markDirty();

        // If the list is sorted by category, re-categorize after adding new items.
        if (sort === 'category') {
            setTimeout(async () => {
                await handleAutoCategorize();
            }, 100);
        }
    };

    const handleViewRecipe = (meal: Meal) => {
        if (!meal.recipeId) {
            Alert.alert("No Recipe", "A recipe has not been added for this meal yet.");
            return;
        }
        setRecipeToViewId(meal.recipeId);
    };


    const handleAddRecipe = (meal: Meal) => setRecipeToEdit(meal);

    const handleAddMealsFromSuggestion = (newMeals: Meal[], newItemsFromModal: Item[]) => {
        setMeals(prev => [...prev, ...newMeals]);
        setItems(currentItems => {
            let lastRank = currentItems.length > 0 && currentItems[currentItems.length - 1].text !== ''
                    ? LexoRank.parse(currentItems[currentItems.length - 1].listOrder)
                    : LexoRank.middle();
            const rankedNewItems = newItemsFromModal.map(item => {
                lastRank = lastRank.genNext();
                return { ...item, listOrder: lastRank.toString() };
            });
            const isSingleEmpty = currentItems.length === 1 && (currentItems[0].text ?? '') === '' && !currentItems[0].isSection;
            return isSingleEmpty ? rankedNewItems : [...currentItems, ...rankedNewItems];
        });
        markDirty();
        if(sort == 'category') {
            setTimeout(async () => {
                await handleAutoCategorize();
            }, 100);
        }
    };

    const handleAddMeal = () => {
        if (!selectedGroup || !selectedList) return;
        const newMeal: Meal = {
            id: uuid.v4() as string,
            listId: selectedList.id,
            name: '',
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
            scheduleMealRating(mealId, selectedList.id, updates.dayOfWeek).catch(console.error);
        }
    };
    
    const handleDeleteMeal = (mealId: string) => {
        setMeals(prev => prev.filter(meal => meal.id !== mealId));
        setItems(prev => prev.filter(item => item.mealId !== mealId));
        markDirty();
    };

    const handleAutoCategorize = async () => {
        if (!selectedGroup || !selectedList?.id) return;
        setIsCategorizing(true);
        markDirty();
        try {
            const newItems = await categorizeList(selectedGroup.id, selectedList.id, items);
            setItems(newItems);
            setSort('category'); // Set sort mode to category
            setEditingId('');
        } catch (err) {
            console.error('Auto-categorization failed', err);
        } finally {
            setIsCategorizing(false);
        }
    };

    const handleToggleCookbookById = async (recipeId: string) => {
        const isInCookbook = cookbookRecipeIds.has(recipeId);
        const originalCookbookIds = new Set(cookbookRecipeIds);

        setCookbookRecipeIds(prev => {
            const newSet = new Set(prev);
            if (isInCookbook) {
                newSet.delete(recipeId);
            } else {
                newSet.add(recipeId);
            }
            return newSet;
        });

        try {
            if (isInCookbook) {
                await removeUserCookbookRecipe(recipeId);
            } else {
                await addUserCookbookRecipe(recipeId);
            }
        } catch (error) {
            console.error(`Failed to ${isInCookbook ? 'remove from' : 'add to'} cookbook:`, error);
            Alert.alert("Error", `Could not update your cookbook. Please try again.`);
            setCookbookRecipeIds(originalCookbookIds);
        }
    };

    const handleToggleCookbook = async (meal: Meal) => {
        if(!user || user.isAnonymous) {
            router.navigate('/profile');
            return;
        }
        if (!meal.recipeId) return;
        await handleToggleCookbookById(meal.recipeId);
    };
    
    const handleAddItem = (isSection = false) => {
    if (sort === 'alphabetical') {
        // This case should no longer be reachable, but as a safeguard,
        // we'll switch to custom before adding.
        setSort('custom');
    }

    if (!selectedList) return;
    const lastOrder = items.length > 0 && items[items.length - 1].text !== '' ? LexoRank.parse(items[items.length - 1].listOrder) : LexoRank.middle();
    const newItem: Item = { id: uuid.v4() as string, text: '', checked: false, listOrder: lastOrder.genNext().toString(), isSection: isSection };
    const newItems = items.length === 1 && items[0].text === '' ? [newItem] : [...items, newItem];
    setItems(newItems);
    setEditingId(newItem.id);
    markDirty();
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
                } catch (e) { console.error("Failed to check for pending action:", e); }
            };
            checkForPendingAction();
        }, [])
    );

    useFocusEffect(
        useCallback(() => {
            // Immediately return if the check has already been done for this session
            if (hasCheckedForUnratedMeals.current) {
                return;
            }

            const checkForPastUnratedMeals = async () => {
                if (!meals.length || !selectedList) return;

                // Mark that the check is being performed
                hasCheckedForUnratedMeals.current = true;

                try {
                    const ratedMealsRaw = await AsyncStorage.getItem('ratedMeals');
                    const ratedMealIds = ratedMealsRaw ? JSON.parse(ratedMealsRaw) : {};
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);

                    const unratedPastMeals = meals.filter(meal => {
                        if (!meal.dayOfWeek || !meal.recipeId || ratedMealIds[meal.id]) return false;
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

            // Delay the check slightly to ensure data is stable
            const timer = setTimeout(checkForPastUnratedMeals, 1000);

            // Cleanup the timer
            return () => clearTimeout(timer);
        }, [meals, selectedList, router]) // Dependencies are still needed to get the correct values
    );

    const onToggleMealCollapse = async (mealId: string) => {
        const updatedStates = { ...collapsedMeals, [mealId]: !collapsedMeals[mealId] };
        setCollapsedMeals(updatedStates);
        try {
            await AsyncStorage.setItem('collapsedMealState', JSON.stringify(updatedStates));
        } catch (e) { console.error("Failed to save collapsed meal state.", e); }
    };

    const mealsWithCookbookStatus = React.useMemo(() => {
        return meals.map(meal => ({
            ...meal,
            addedToCookbook: meal.recipeId ? cookbookRecipeIds.has(meal.recipeId) : false,
        }));
    }, [meals, cookbookRecipeIds]);

    if (isLoading) {
        return <View style={styles.container}><ActivityIndicator /></View>;
    }

    return (
        <>
        {isFocused && <StatusBar style="dark" />}
        <View style={{ paddingTop: 12, paddingBottom: 12,flex: 1, backgroundColor: '#fff' }}>
            <KeyboardAvoidingView
                style={styles.container}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={100}
            >
                {/* TODO: the keyboardavoiding here is not as good as on login page now. also add/edit recipe one is good. (CHECK IOS) */}
                {/* TODO: on IOS, any action outside the keyboard should minimize it (unless its a click to another input). basically we want the keyboard to be smart enough to close when were not using it (on scroll)*/}
                {/* TODO: on android, any action outside the keyboard should not minimize it, we use the back swipe to do this. */}
                { selectedView == ListView.GroceryList ? (
                    <GroceryListView
                        items={items}
                        setItems={setItems}
                        sort={sort}
                        setSort={setSort}
                        onCategorize={handleAutoCategorize}
                        editingId={editingId}
                        setEditingId={setEditingId}
                        inputRefs={inputRefs}
                        isKeyboardVisible={isKeyboardVisible}
                        markDirty={markDirty}
                    />
                ) : (
                    <MealPlanView
                        meals={mealsWithCookbookStatus}
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
                        onToggleCookbook={handleToggleCookbook}
                    />
                )}
            </KeyboardAvoidingView>

            {isFabMenuOpen && (
                <Pressable style={StyleSheet.absoluteFill} onPress={() => setIsFabMenuOpen(false)} />
            )}

            <View style={styles.fabContainer}>
                {isFabMenuOpen && (
                    <>
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
                isInCookbook={recipeToViewId ? cookbookRecipeIds.has(recipeToViewId) : false}
                onCookbookUpdate={() => {
                    if (recipeToViewId) handleToggleCookbookById(recipeToViewId);
                }}
            />
            <AddEditRecipeModal isVisible={!!recipeToEdit} onClose={() => setRecipeToEdit(null)} mealForRecipe={recipeToEdit} onRecipeSave={handleRecipeSaved} />
            <MealSuggestionsModal isVisible={isSuggestionModalVisible} onClose={() => setSuggestionModalVisible(false)} onAddSelectedMeals={handleAddMealsFromSuggestion} listId={selectedList?.id ?? ''} />
        </View>
        </>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#fff' },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.2)',
    },
    fabContainer: {
        position: 'absolute',
        bottom: 30,
        right: 20,
        alignItems: 'flex-end',
        width: 80
    },
    fab: {
        width: 60,
        height: 60,
        borderRadius: 30,
        backgroundColor: primary,
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
        right: 6,
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