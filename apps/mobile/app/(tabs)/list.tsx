// ListScreen.tsx

import AddEditRecipeModal from '@/components/AddEditRecipeModal';
import GroceryListView, { type GroceryListHandle } from '@/components/GroceryListView'; // Import the new component
import MealPlanView from '@/components/MealPlanView';
import AddFromCookbookModal from '@/components/AddFromCookbookModal';
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
    Modal,
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
import { addUserCookbookRecipe, categorizeList, CLIENT_ID, getUserCookbook, listenToList, removeUserCookbookRecipe, StaleRevError, updateList } from '../../utils/api';
import { cancelMealRatingReminder, scheduleMealRatingReminder } from '../../utils/mealReminders';
import { parseWeekStart } from '../../utils/date';
import { nextListRank, sanitizeListOrders } from '../../utils/rank';

// RTDB stores a JS array as a keyed object and only hands it back as an array
// while the keys stay 0..n with no gaps. Reading a stored list as "array or
// nothing" throws the whole thing away the first time that isn't true, which
// shows up as a week that has emptied itself.
function asArray<T>(value: T[] | undefined): T[] {
    return Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
}

export default function HomeScreen() {
    const router = useRouter();
    const { selectedList, isLoading, selectedGroup, selectedView, allLists } = useLists();
    const { user } = useAuth();
    
    const [meals, setMeals] = useState<Meal[]>([]);
    const [items, setItems] = useState<Item[]>([]);
    // Department order is the default: a grocery list is walked aisle by aisle,
    // and a list that arrives without a stored `sort` has never been given one
    // rather than having been deliberately set to custom.
    const [sort, setSort] = useState<List['sort']>('category');

    const [editingId, setEditingId] = useState<string>('');
    // Any filing in flight, automatic or asked for. Gates the auto-file effect
    // so two passes can't race.
    const [isCategorizing, setIsCategorizing] = useState(false);
    // Only a whole-list re-sort the user asked for. Filing happens constantly
    // now, and turning the Sort button into a spinner every time an item lands
    // would make the list look busy doing something nobody requested.
    const [isSorting, setIsSorting] = useState(false);
    const [isKeyboardVisible, setKeyboardVisible] = useState(false);
    const inputRefs = useRef<Record<string, TextInput | null>>({});

    // True from the moment a different week is selected until that week's first
    // snapshot lands. Distinct from the context's `isLoading`, which covers
    // fetching the set of weeks, not the contents of one.
    const [isListLoading, setIsListLoading] = useState(true);

    const [isSuggestionModalVisible, setSuggestionModalVisible] = useState(false);
    const [isCookbookModalVisible, setCookbookModalVisible] = useState(false);


    const [collapsedMeals, setCollapsedMeals] = useState<Record<string, boolean>>({});

    const [recipeToViewId, setRecipeToViewId] = useState<string | null>(null);
    const [recipeToEdit, setRecipeToEdit] = useState<Meal | null>(null);

    const [isFabMenuOpen, setIsFabMenuOpen] = useState(false);
    const fabAnimation = useSharedValue(0);

    const [cookbookRecipeIds, setCookbookRecipeIds] = useState<Set<string>>(new Set());

    const hasCheckedForUnratedMeals = useRef(false);

    const [isFocused, setIsFocused] = useState(false);

    const listRef = useRef<GroceryListHandle | null>(null);
    
    // --- Start of new/moved code ---
    const [isSortModalVisible, setIsSortModalVisible] = useState(false);
    // --- End of new/moved code ---

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
        // 3. The row that was being edited belongs to the view we just left and
        // has been unmounted. React Native does not fire onBlur for that, so
        // nothing else would ever clear this.
        setEditingId('');
    }, [selectedView]);

    // Marks a short window in which the user is actively editing. This is no
    // longer used to suppress our OWN echo (lastClientId does that precisely);
    // it only defers applying ANOTHER client's snapshot mid-keystroke. Deferring
    // is safe now: our next save carries `rev`, so if we did miss someone's
    // write the server 409s us and we rebase instead of clobbering them.
    const dirtyUntilRef = useRef<number>(0);
    const markDirty = () => {
        const until = Date.now() + 1200;
        dirtyUntilRef.current = until;
    };

    // Last rev we have seen for the selected list, sent with every save so the
    // server can reject writes built on a stale snapshot.
    const revRef = useRef<number | undefined>(undefined);

    // The list on screen right now, readable from an async callback that closed
    // over an older one. Requests in flight when the week changes answer about
    // the list they were asked about, not the one being looked at.
    const selectedListIdRef = useRef<string | undefined>(undefined);
    selectedListIdRef.current = selectedList?.id;

    // Animate FAB menu
    useEffect(() => {
        fabAnimation.value = withTiming(isFabMenuOpen ? 1 : 0, { duration: 250 });
    }, [isFabMenuOpen]);


    const fabRotation = useAnimatedStyle(() => ({
        transform: [{ rotate: `${fabAnimation.value * 45}deg` }],
    }));

    const fabStyle0 = useAnimatedStyle(() => ({
        transform: [{ translateY: fabAnimation.value * -80 }],
        opacity: fabAnimation.value,
    }));
    const fabStyle1 = useAnimatedStyle(() => ({
        transform: [{ translateY: fabAnimation.value * -145 }],
        opacity: fabAnimation.value,
    }));
    const fabStyle2 = useAnimatedStyle(() => ({
        transform: [{ translateY: fabAnimation.value * -210 }],
        opacity: fabAnimation.value,
    }));


    // True while the latest items/meals/sort state came from the server (WS or
    // categorize) rather than a local edit — those changes must NOT be saved
    // back, or every broadcast would trigger a write and clients would
    // ping-pong saves at each other.
    const applyingRemoteRef = useRef(false);
    // No saves until the first server snapshot for the current list has
    // arrived; otherwise the debounced save could overwrite the list with the
    // initial empty state.
    const hasLoadedRef = useRef(false);

    // Ids we tried and failed to file. Without this the auto-sort effect would
    // spin on every render for as long as the request keeps failing.
    const sortFailedIdsRef = useRef<Set<string>>(new Set());

    const hasText = (i: Item) => !i.isSection && (i.text ?? '').trim() !== '';

    // An item carries the aisle the server filed it under. Its ABSENCE is what
    // marks a row as still needing one — this used to be an in-memory set of
    // ids, which meant a list reopened after the app was closed looked entirely
    // sorted and the rows added just before closing never got a department.
    const needsSection = (i: Item) =>
        hasText(i) && !i.section && !sortFailedIdsRef.current.has(i.id);

    const applyRemoteList = (list: List) => {
        if (!list) return;
        applyingRemoteRef.current = true;
        hasLoadedRef.current = true;
        setIsListLoading(false);
        if (typeof list.rev === 'number') revRef.current = list.rev;

        // Repair missing/invalid LexoRanks (e.g. legacy 'NEEDS-RANK' rows), and
        // read `items` in whichever shape RTDB stored it — an array with a hole
        // in it comes back as a keyed object, and demanding Array.isArray here
        // meant showing an empty list rather than the one we were sent.
        const withOrder = sanitizeListOrders(list.items)
            .sort((a: Item, b: Item) => (a.listOrder ?? '').localeCompare(b.listOrder ?? ''));

        // An empty list is left empty. It used to be given a blank placeholder
        // row, which the grocery view renders as an unlabelled checkbox — one
        // more empty row to clean up, and one the user never asked for. The view
        // has a real empty state and offers to add the first item itself.
        setItems(withOrder);
        // `meals` can come back keyed too, for the same reason.
        setMeals(asArray(list.meals));
        setSort(list.sort || 'category');
    };

    // Handles ALL incoming data (Initial Fetch + Real-time Updates)
    useEffect(() => {
        if (!selectedList?.id || !selectedGroup?.id) {
            setItems([]);
            setMeals([]);
            setIsListLoading(false);
            return;
        }
        hasLoadedRef.current = false;
        revRef.current = undefined;
        // Nothing on screen belongs to the week we are switching to. Holding on
        // to the previous list's items and meals until a snapshot arrives shows
        // one week's food under another week's heading, which reads as real
        // rather than as still loading.
        setItems([]);
        setMeals([]);
        setIsListLoading(true);
        // These track ids on the list being left behind; the snapshot for the
        // new one decides its own state.
        sortFailedIdsRef.current = new Set();

        // listenToList fetches an auth token before it opens the socket, so the
        // unsubscribe it hands back can arrive AFTER this effect has been torn
        // down. Waiting on the variable alone meant a week switched during that
        // window left the old socket open forever, and its snapshot landed on
        // top of the new week. The flag closes over the teardown instead.
        let cancelled = false;
        let unsubscribe: (() => void) | undefined;
        const setupListener = async () => {
            try {
                const stop = await listenToList(selectedGroup.id, selectedList.id, (list: List) => {
                    if (cancelled) return;
                    // A null snapshot is the server saying there is nothing at
                    // that path. That is an answer, so stop waiting on one:
                    // holding the spinner up leaves the screen blank forever
                    // over a list that is simply not there.
                    if (!list) {
                        setIsListLoading(false);
                        return;
                    }

                    // The first snapshot for a list is its load, not an update
                    // to something we already hold, so it applies no matter who
                    // wrote it last. Both guards below are about updates.
                    const isInitialLoad = !hasLoadedRef.current;

                    // Our own write echoing back — never re-apply it. Once
                    // loaded, that is: `lastClientId` is stored ON the list
                    // document, so the first snapshot of a list this session
                    // wrote to earlier still carries our id. Hard-ignoring that
                    // one left the previous week on screen and, with
                    // hasLoadedRef never set, silently disabled saving for the
                    // week the user was actually looking at.
                    if (!isInitialLoad && list.lastClientId === CLIENT_ID) {
                        if (typeof list.rev === 'number') revRef.current = list.rev;
                        return;
                    }

                    // Server-initiated (add-meal, categorize, migration) — these
                    // carry no clientId and MUST always be applied. Time-gating
                    // them is what let a meal added from Explore get silently
                    // deleted by the next debounced save.
                    const serverInitiated = list.lastClientId == null;

                    // Another client's edit, while we're mid-keystroke: defer.
                    // Our next save sends the older rev, so the server 409s it
                    // and we rebase rather than overwriting their change.
                    if (!isInitialLoad && !serverInitiated && Date.now() < dirtyUntilRef.current) return;

                    applyRemoteList(list);
                });
                if (cancelled) {
                    stop();
                    return;
                }
                unsubscribe = stop;
            } catch (error) {
                console.error("Failed to set up list listener:", error);
            }
        };
        setupListener();
        return () => {
            cancelled = true;
            unsubscribe?.();
        };
        // Depend on stable IDs: presence updates re-create the group object and
        // would otherwise tear the socket down on every status change.
    }, [selectedList?.id, selectedGroup?.id]);

    // Handles ALL outgoing data (Debounced Saving)
     useEffect(() => {
        if (!selectedList?.id || !selectedGroup?.id) return;
        if (!hasLoadedRef.current) return;
        if (applyingRemoteRef.current) {
            applyingRemoteRef.current = false;
            return;
        }
        const groupId = selectedGroup.id;
        const listId = selectedList.id;
        const timeout = setTimeout(() => {
            updateList(groupId, listId, { items, meals, sort }, revRef.current)
                .then(res => { if (typeof res?.rev === 'number') revRef.current = res.rev; })
                .catch(err => {
                    if (err instanceof StaleRevError) {
                        // Someone committed first. Rebase onto their document
                        // instead of overwriting it; without this the last
                        // writer silently wins and the other user's edit is gone.
                        console.warn('List save was stale; rebasing onto rev', err.rev);
                        if (err.list) applyRemoteList(err.list);
                        // Nothing to rebase onto. Keeping the rejected revision
                        // would make every following save 409 the same way, so
                        // let the next one through and take the snapshot after.
                        else revRef.current = undefined;
                        return;
                    }
                    console.error(err);
                });
        }, 500);
        return () => clearTimeout(timeout);
    }, [items, meals, sort, selectedList?.id, selectedGroup?.id]);

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

        // Ask the view to bring the row into sight, rather than computing an
        // index here. `items` is not what the grocery list renders: identical
        // texts are merged into one row, so an index into `items` overshoots the
        // rendered array by one per duplicate — and scrollToIndex past the end
        // throws, which takes the whole screen down. Only the view knows how its
        // own rows map back to item ids.
        //
        // The delay lets the keyboard finish coming up first.
        const timer = setTimeout(() => listRef.current?.scrollToItemId?.(editingId), 100);
        return () => clearTimeout(timer);
    }, [editingId, items]);

    useEffect(() => {
        const keyboardDidShowListener = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
        const keyboardDidHideListener = Keyboard.addListener('keyboardDidHide', () => {
            setKeyboardVisible(false);
            // With the keyboard down nothing is being typed into, whatever the
            // focus state says. React Native does not report a blur when the
            // keyboard is dismissed by a drag or the Android back gesture, and
            // a stale editingId holds off both filing and blank-row cleanup.
            setEditingId('');
        });
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
            const base = currentItems
                .filter(item => item.mealId !== updatedMeal.id)
                .filter(i => (i.text ?? '').trim() !== '' || i.isSection);
            // Modal items arrive with placeholder orders ('NEEDS-RANK'); assign
            // real ranks here or LexoRank.parse will throw on the next insert.
            let listRank = nextListRank(base);
            let mealRank = LexoRank.middle();
            const rankedNewItems = newItems
                .filter(i => (i.text ?? '').trim() !== '')
                .map(i => {
                    listRank = listRank.genNext();
                    mealRank = mealRank.genNext();
                    return { ...i, listOrder: listRank.toString(), mealOrder: i.mealOrder ?? mealRank.toString() };
                });
            return [...base, ...rankedNewItems];
        });
        markDirty();
        // No categorize call here. The auto-sort effect picks these ingredients
        // up off the committed state a moment later, which is what the old code
        // had to rebuild the ranked item list by hand to approximate — it fired
        // before React had applied the update above, so it categorized a
        // snapshot that did not contain these ingredients and wrote it back,
        // erasing them.
    };

    const handleViewRecipe = (meal: Meal) => {
        if (!meal.recipeId) {
            Alert.alert("No Recipe", "A recipe has not been added for this meal yet.");
            return;
        }
        setRecipeToViewId(meal.recipeId);
    };


    const handleAddRecipe = (meal: Meal) => setRecipeToEdit(meal);

    const handleAddMealsFromSuggestion = async (newMeals: Meal[], newItemsFromModal: Item[]) => {
        // 1. Prepare the new state variables
        const updatedMeals = [...meals, ...newMeals];

        let lastRank = nextListRank(items);
        let mealRank = LexoRank.middle();
        const rankedNewItems = newItemsFromModal.map(item => {
            lastRank = lastRank.genNext();
            mealRank = mealRank.genNext();
            return { ...item, listOrder: lastRank.toString(), mealOrder: item.mealOrder ?? mealRank.toString() };
        });

        const isSingleEmpty = items.length === 1 && (items[0].text ?? '') === '' && !items[0].isSection;
        const finalNewItems = isSingleEmpty ? rankedNewItems : [...items, ...rankedNewItems];

        // 2. Perform the optimistic UI update
        setMeals(updatedMeals);
        setItems(finalNewItems);
        markDirty(); // Keep the dirty flag to prevent immediate listener overwrites

        try {
            // 3. Save the new, still-unsorted items immediately rather than
            // waiting out the debounce — these came from a modal the user has
            // just dismissed, and losing them to a backgrounded app would be
            // losing a whole meal plan. The auto-sort effect files them into
            // departments once the state above has committed.
            if (selectedGroup && selectedList) {
                const res = await updateList(selectedGroup.id, selectedList.id, {
                    items: finalNewItems,
                    meals: updatedMeals,
                    sort: sort,
                }, revRef.current);
                if (typeof res?.rev === 'number') revRef.current = res.rev;
            }
        } catch (error) {
            console.error("Failed to save suggested meals:", error);
            // Optional: Implement logic to revert the optimistic update on error
            Alert.alert("Error", "Could not save new meals. Please try again.");
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

        if (!selectedList) return;
        // Reconcile against the MERGED meal rather than just `updates`: a rating
        // reminder needs both a day and a recipe, and either can arrive in a
        // separate edit from the other.
        const existing = meals.find(m => m.id === mealId);
        const merged = { ...existing, ...updates } as Meal;

        if (merged.dayOfWeek && merged.recipeId) {
            scheduleMealRatingReminder({
                listId: selectedList.id,
                mealId,
                recipeId: merged.recipeId,
                mealName: merged.name ?? '',
                weekStart: selectedList.weekStart,
                dayOfWeek: merged.dayOfWeek,
            }).catch(console.error);
        } else {
            // Day cleared, or no recipe to rate — the reminder would open a
            // screen that immediately bounces the user back.
            cancelMealRatingReminder(selectedList.id, mealId).catch(console.error);
        }
    };

    const handleDeleteMeal = (mealId: string) => {
        setMeals(prev => prev.filter(meal => meal.id !== mealId));
        setItems(prev => prev.filter(item => item.mealId !== mealId));
        markDirty();
        if (selectedList) {
            cancelMealRatingReminder(selectedList.id, mealId).catch(console.error);
        }
    };

    /**
     * Folds a categorize response back into local state.
     *
     * Filing now happens while the keyboard is still up, so the answer can
     * arrive after the user has typed more, added a row or deleted one. Taking
     * the response wholesale would undo all of that, so only the filing
     * decision — where a row sits and which aisle it is in — is taken from the
     * server; everything else stays as the user last left it.
     */
    const applyFiledItems = (filed: Item[]) => {
        setItems(current => {
            const byId = new Map(current.map(i => [i.id, i]));

            // An answer that names rows and matches none of them is not an
            // answer about this list — it is about a state we have since
            // replaced, most often because the snapshot for another week landed
            // while the model was thinking. Merging it keeps only the section
            // headings it invented and drops every row, which then saves.
            const namesRows = filed.some(i => !i.isSection);
            if (namesRows && !filed.some(i => !i.isSection && byId.has(i.id))) return current;

            const merged = filed
                // Section rows are the server's to invent; anything else that is
                // no longer here was deleted locally and must stay deleted.
                .filter(i => i.isSection || byId.has(i.id))
                .map(i => {
                    const local = byId.get(i.id);
                    if (!local) return i;
                    // Renamed since we asked: the aisle we got back is for the
                    // old text, so leave the row unfiled and let the next pass
                    // decide where it really goes.
                    const renamed = (local.text ?? '') !== (i.text ?? '');
                    return renamed
                        ? { ...local, listOrder: i.listOrder }
                        : { ...local, listOrder: i.listOrder, section: i.section };
                });

            // Rows added locally after the request went out aren't in the answer
            // and the ranks it came back with are new, so put them on the end.
            const answered = new Set(filed.map(i => i.id));
            let rank = nextListRank(merged);
            for (const item of current) {
                if (answered.has(item.id)) continue;
                merged.push({ ...item, listOrder: rank.toString() });
                rank = rank.genNext();
            }

            return sanitizeListOrders(merged);
        });
    };

    /**
     * Files items into supermarket aisles.
     *
     * With `itemIds` only those rows move and the rest of the list is left
     * alone — that is the automatic path, and it runs on every add. Without
     * them the whole list is re-sorted, which is what the Sort by Category
     * button asks for.
     */
    const handleAutoCategorize = async (itemIds?: string[]) => {
        if (!selectedGroup || !selectedList?.id) return;
        setIsCategorizing(true);
        if (!itemIds) setIsSorting(true);
        markDirty();

        // Always the committed state. Every caller used to have the option of
        // passing its own not-yet-applied array instead, which is exactly how a
        // list got sorted without the items that had just been added to it.
        const currentItems = items;
        // The list this answer will be about. Filing is a model call, so the
        // user can be on another week by the time it lands, and the merge below
        // matches on item id: against a different week nothing matches, so every
        // row of THAT list would be treated as locally deleted.
        const askedForListId = selectedList.id;

        try {
            const { items: newItems, rev } = await categorizeList(selectedGroup.id, selectedList.id, currentItems, itemIds);
            if (selectedListIdRef.current !== askedForListId) return;
            applyFiledItems(sanitizeListOrders(newItems));
            // This write moved the list on; adopt its revision so the save that
            // follows isn't rejected as stale and rebased over the merge above.
            if (typeof rev === 'number') revRef.current = rev;
            sortFailedIdsRef.current = new Set();
            setSort('category'); // Set sort mode to category
            // Re-sorting the whole list rearranges everything, so there is no row
            // left to go back to. Filing one new row is not a reason to drop the
            // user out of the one they are typing in.
            if (!itemIds) setEditingId('');
        } catch (err) {
            console.error('Auto-categorization failed', err);
            if (selectedListIdRef.current !== askedForListId) return;
            // Give up on these particular items until something else changes,
            // so the auto-sort effect doesn't retry them on every render.
            const failed = itemIds ?? currentItems.filter(hasText).map(i => i.id);
            for (const id of failed) sortFailedIdsRef.current.add(id);
        } finally {
            setIsCategorizing(false);
            setIsSorting(false);
        }
    };

    // Rows that have text but no department yet — a hand-typed grocery row, an
    // ingredient typed into a meal, a recipe's ingredients, a generated meal
    // plan. The row currently being typed into is deliberately left out: filing
    // it would move it out from under the cursor. It gets picked up by the next
    // pass, which the blur ending the edit triggers.
    const unsortedIds = items.filter(i => needsSection(i) && i.id !== editingId).map(i => i.id);
    // A string, so the effect below re-runs when WHICH rows need filing changes
    // rather than on every keystroke that leaves the count the same.
    const unsortedKey = unsortedIds.join(',');

    // Department order is what a grocery list is for, so it is not a mode the
    // user has to ask for: every path that puts an item on the list ends here
    // and the item is filed into its aisle. Adding a row, typing an ingredient
    // into a meal, saving a recipe and generating meals all just change `items`.
    useEffect(() => {
        if (sort !== 'category') return;
        if (unsortedIds.length === 0) return;
        if (isCategorizing) return;
        if (!hasLoadedRef.current || !selectedGroup || !selectedList?.id) return;

        // Long enough that typing a run of items costs one call, not one per
        // item, and short enough to feel like the list is filing itself.
        const timer = setTimeout(() => { handleAutoCategorize(unsortedIds).catch(console.error); }, 700);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [unsortedKey, sort, isCategorizing, items, selectedGroup?.id, selectedList?.id]);

    // Rows with nothing in them are scaffolding: one you added and never typed
    // into, an ingredient abandoned in the meal plan, an unnamed heading, the
    // placeholder an empty list used to be given. They render as a bare checkbox
    // or a blank heading and, left alone, they pile up. Once the keyboard is
    // down and nothing is focused they have served their purpose.
    //
    // The delay is load-bearing: moving between two rows blurs the first before
    // it focuses the second, and for that moment nothing is being edited.
    // Pruning on the spot would delete the blank row the user just tapped into.
    useEffect(() => {
        if (editingId || isKeyboardVisible) return;
        const isBlank = (i: Item) => (i.text ?? '').trim() === '';
        if (!items.some(isBlank)) return;

        const timer = setTimeout(() => {
            setItems(prev => prev.filter(i => !isBlank(i)));
            markDirty();
        }, 400);
        return () => clearTimeout(timer);
    }, [items, editingId, isKeyboardVisible]);

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

    // Writing your own category heading is organising the list by hand, the
    // same as dragging a row is. Auto department sort rebuilds the headings
    // from scratch, so it would delete this one the moment the next item
    // landed; opt out of it instead, exactly as reordering does.
    if (isSection) setSort('custom');

    if (!selectedList) return;

    // An empty row already waiting for text IS the row being asked for. Without
    // this, every tap stacked up another unlabelled checkbox.
    const blank = items.find(i => !i.isSection && !i.mealId && (i.text ?? '').trim() === '');
    if (!isSection && blank) {
        setEditingId(blank.id);
        return;
    }

    const newItem: Item = { id: uuid.v4() as string, text: '', checked: false, listOrder: nextListRank(items).toString(), isSection: isSection };
    setItems([...items, newItem]);
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

                    // parseWeekStart interprets weekStart in LOCAL time; a bare
                    // `new Date('yyyy-MM-dd')` would be UTC midnight (the
                    // previous day across the Americas).
                    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                    const mealDateOf = (dayOfWeek: string) => {
                        const date = parseWeekStart(selectedList.weekStart);
                        date.setDate(date.getDate() + DAY_NAMES.indexOf(dayOfWeek));
                        return date;
                    };
                    const unratedPastMeals = meals.filter(meal => {
                        if (!meal.dayOfWeek || !meal.recipeId || ratedMealIds[meal.id]) return false;
                        return mealDateOf(meal.dayOfWeek) < today;
                    });

                    if (unratedPastMeals.length > 0) {
                        const mealToRate = unratedPastMeals.sort((a, b) =>
                            mealDateOf(b.dayOfWeek!).getTime() - mealDateOf(a.dayOfWeek!).getTime()
                        )[0];

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
    
    // --- Start of new/moved code ---
    const reRankAlphabetically = (currentItems: Item[]) => {
        const itemsWithoutSections = currentItems.filter(item => !item.isSection);
        const sortedAlphabetically = [...itemsWithoutSections].sort((a, b) => (a.text ?? '').localeCompare(b.text ?? ''));
        
        let rank = LexoRank.middle();
        const rankMap = new Map<string, string>();
        sortedAlphabetically.forEach(item => {
            rank = rank.genNext();
            rankMap.set(item.id, rank.toString());
        });

        return currentItems
            .filter(item => !item.isSection) // ensure sections are removed
            .map(item => ({
                ...item,
                listOrder: rankMap.get(item.id) || item.listOrder
            }));
    };

    const handleSelectSort = (selectedMode: List['sort']) => {
        if (selectedMode === 'category') {
            handleAutoCategorize();
        } else if (selectedMode === 'alphabetical') {
            const newRankedItems = reRankAlphabetically(items);
            setItems(newRankedItems);
            setSort('custom'); // Immediately set the mode to custom, locking in the new order.
        } else {
            // This case handles selecting "Custom" which does nothing but close the modal.
            setSort('custom');
        }
        setIsSortModalVisible(false);
    };

    const getSortIconText = () => {
        switch (sort) {
            case 'alphabetical': return "Alpha";
            case 'category': return "Category";
            default: return "Sort";
        }
    };
    // --- End of new/moved code ---

    const mealsWithCookbookStatus = React.useMemo(() => {
        return meals.map(meal => ({
            ...meal,
            addedToCookbook: meal.recipeId ? cookbookRecipeIds.has(meal.recipeId) : false,
        }));
    }, [meals, cookbookRecipeIds]);

    if (isLoading || (selectedList && isListLoading)) {
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
                        editingId={editingId}
                        setEditingId={setEditingId}
                        inputRefs={inputRefs}
                        isKeyboardVisible={isKeyboardVisible}
                        markDirty={markDirty}
                        ref={listRef} 
                    />
                ) : (
                    <MealPlanView
                        meals={mealsWithCookbookStatus}
                        items={items}
                        setAllItems={setItems}
                        onUpdateMeal={handleUpdateMeal}
                        onDeleteMeal={handleDeleteMeal}
                        onAddMeal={handleAddMeal}
                        onAddFromCookbook={() => setCookbookModalVisible(true)}
                        onSuggestMeal={() => setSuggestionModalVisible(true)}
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

            <View style={styles.bottomActionContainer}>
                 {/* --- Start of new/moved code: Sort Button --- */}
                 {selectedView === ListView.GroceryList && (
                    <TouchableOpacity style={styles.sortButton} onPress={() => setIsSortModalVisible(true)} disabled={isCategorizing}>
                        {isSorting ? (
                            <>
                                <ActivityIndicator size="small" color={primary} />
                                <Text style={styles.sortButtonText}>Sorting…</Text>
                            </>
                        ) : (
                            <>
                                <Ionicons name={'swap-vertical-outline'} size={20} color={primary} />
                                <Text style={styles.sortButtonText}>{getSortIconText()}</Text>
                            </>
                        )}
                    </TouchableOpacity>
                 )}
                 { selectedView != ListView.GroceryList && (
                    <TouchableOpacity>
                        <Text style={styles.sortButtonText}>&nbsp;</Text>
                    </TouchableOpacity>
                 )}
                 {/* --- End of new/moved code --- */}

                <View style={styles.fabContainer}>
                    {isFabMenuOpen && (
                        <>
                            {selectedView === ListView.MealPlan ? (
                                // Ordered by expected use: the nearest to the FAB is the
                                // quickest action, the furthest is the most involved.
                                <>
                                    <Animated.View style={[styles.secondaryFabContainer, fabStyle2]}>
                                        <TouchableOpacity style={styles.secondaryButton} onPress={() => { setSuggestionModalVisible(true); setIsFabMenuOpen(false); }}>
                                            <Ionicons name="sparkles" size={20} color="#333" style={styles.secondaryButtonIcon}/>
                                            <Text style={styles.secondaryButtonText}>Suggest Meal</Text>
                                        </TouchableOpacity>
                                    </Animated.View>
                                    <Animated.View style={[styles.secondaryFabContainer, fabStyle1]}>
                                        <TouchableOpacity style={styles.secondaryButton} onPress={() => { setCookbookModalVisible(true); setIsFabMenuOpen(false); }}>
                                            <Ionicons name="book-outline" size={20} color="#333" style={styles.secondaryButtonIcon}/>
                                            <Text style={styles.secondaryButtonText}>From Cookbook</Text>
                                        </TouchableOpacity>
                                    </Animated.View>
                                    <Animated.View style={[styles.secondaryFabContainer, fabStyle0]}>
                                        <TouchableOpacity style={styles.secondaryButton} onPress={() => { handleAddMeal(); setIsFabMenuOpen(false); }}>
                                            <Ionicons name="add-outline" size={20} color="#333" style={styles.secondaryButtonIcon}/>
                                            <Text style={styles.secondaryButtonText}>New Meal</Text>
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
            {/* Adds through POST /meal, so the server broadcasts it and the list
                updates live — no local optimistic write to reconcile. */}
            <AddFromCookbookModal
                isVisible={isCookbookModalVisible}
                onClose={() => setCookbookModalVisible(false)}
                listId={selectedList?.id ?? ''}
            />
            
            {/* --- Start of new/moved code: Sort Modal --- */}
            <Modal
                transparent={true}
                visible={isSortModalVisible}
                onRequestClose={() => setIsSortModalVisible(false)}
                animationType="fade"
            >
                <Pressable style={styles.modalOverlay} onPress={() => setIsSortModalVisible(false)}>
                    <View style={styles.sortModalContent}>
                        <Text style={styles.sortModalTitle}>Sort List By</Text>
                        
                        <TouchableOpacity style={styles.sortOption} onPress={() => handleSelectSort('custom')}>
                            <Ionicons name="swap-vertical-outline" size={24} color={primary} style={styles.sortIcon}/>
                            <Text style={styles.sortOptionText}>Custom</Text>
                            {sort === 'custom' && <Ionicons name="checkmark-circle" size={24} color="#4CAF50" />}
                        </TouchableOpacity>

                        <TouchableOpacity style={styles.sortOption} onPress={() => handleSelectSort('alphabetical')}>
                            <Ionicons name="text-outline" size={24} color={primary} style={styles.sortIcon}/>
                            <Text style={styles.sortOptionText}>Alphabetical</Text>
                            {sort === 'alphabetical' && <Ionicons name="checkmark-circle" size={24} color="#4CAF50" />}
                        </TouchableOpacity>

                        <TouchableOpacity style={styles.sortOption} onPress={() => handleSelectSort('category')}>
                            <Ionicons name="sparkles-outline" size={24} color={primary} style={styles.sortIcon}/>
                            <Text style={styles.sortOptionText}>By Category</Text>
                            {sort === 'category' && <Ionicons name="checkmark-circle" size={24} color="#4CAF50" />}
                        </TouchableOpacity>
                    </View>
                </Pressable>
            </Modal>
             {/* --- End of new/moved code --- */}
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
    // --- Start of new/moved code ---
    bottomActionContainer: {
        position: 'absolute',
        bottom: 30,
        paddingHorizontal: 20,
        width: '100%',
        flexDirection: 'row',
        justifyContent:'space-between',
        alignItems: 'flex-end',
        gap: 16
    },
    sortButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#fff',
        paddingHorizontal: 16,
        paddingVertical: 12,
        height: 50,
        borderRadius: 25,
        elevation: 6,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
    },
    sortButtonText: {
        marginLeft: 6,
        color: primary,
        fontWeight: '600',
        fontSize: 16,
    },
    // --- End of new/moved code ---
    fabContainer: {
        alignItems: 'flex-end',
        width: 80,
        // The menu buttons deliberately extend past this width.
        overflow: 'visible',
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
        // Anchored to the right and given room to grow leftward. Without an
        // explicit width these size to the 80pt fabContainer and truncate any
        // label longer than about one word ("Suggest M…", "From Cook…").
        right: 6,
        width: 240,
        alignItems: 'flex-end',
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
    // --- Start of new/moved code ---
    modalOverlay: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(0,0,0,0.4)',
    },
    sortModalContent: {
        backgroundColor: 'white',
        borderRadius: 12,
        padding: 20,
        width: '80%',
        elevation: 10,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 10,
    },
    sortModalTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        marginBottom: 20,
        textAlign: 'center',
        color: '#333',
    },
    sortOption: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 15,
    },
    sortIcon: {
        marginRight: 15,
    },
    sortOptionText: {
        fontSize: 16,
        flex: 1,
        color: '#333',
    },
     // --- End of new/moved code ---
});