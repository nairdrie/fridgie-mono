// ListScreen.tsx

import AddEditRecipeModal from '@/components/AddEditRecipeModal';
import CarryOverBanner from '@/components/CarryOverBanner';
import GroceryListView, { type GroceryListHandle } from '@/components/GroceryListView'; // Import the new component
import MealPlanView from '@/components/MealPlanView';
import AddFromCookbookModal from '@/components/AddFromCookbookModal';
import MealSuggestionsModal from '@/components/MealSuggestionsModal';
import SyncStatus from '@/components/SyncStatus';
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
import { addUserCookbookRecipe, alwaysShowStaple, categorizeList, CLIENT_ID, getStaples, getUserCookbook, listenToList, removeUserCookbookRecipe } from '../../utils/api';
import { isOnline } from '../../utils/connectivity';
import { getListSyncEngine, type ListSyncEngine } from '../../utils/listSync';
import { stampEdits } from '../../utils/stamp';
import { cancelMealRatingReminder, scheduleMealRatingReminder } from '../../utils/mealReminders';
import { parseWeekStart } from '../../utils/date';
import { nextListRank, sanitizeListOrders } from '../../utils/rank';

// LIST_SORT moved to utils/listSync — the engine is what writes it now, and it
// must still be written by a flush that happens long after this screen is gone.
//
// Ordering rows by hand is untouched by it: dragging one moves it and it stays
// moved, because filing only ever places the rows that still need a department
// and leaves every other row where it is.

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
    
    const [meals, setMealsRaw] = useState<Meal[]>([]);
    const [items, setItemsRaw] = useState<Item[]>([]);

    /**
     * Every local edit goes through here so the rows it touched carry an
     * `updatedAt`, which is what lets a merge break a genuine collision — two
     * people changing the same field of the same row between two saves.
     *
     * Stamping centrally rather than at the call sites is deliberate: `setItems`
     * is threaded into GroceryListView and MealPlanView and used from a dozen
     * places between them, and a stamp that has to be remembered is a stamp that
     * gets forgotten in the one path that needed it. Diffing against the
     * previous array costs a pass over a few dozen rows and cannot be skipped by
     * accident.
     *
     * Remote snapshots use the raw setters below — a stamp there would make the
     * other person's edit look like it was made on this device.
     */
    const setItems = useCallback<React.Dispatch<React.SetStateAction<Item[]>>>((update) => {
        setItemsRaw(prev => stampEdits(prev, typeof update === 'function' ? update(prev) : update));
    }, []);
    const setMeals = useCallback<React.Dispatch<React.SetStateAction<Meal[]>>>((update) => {
        setMealsRaw(prev => stampEdits(prev, typeof update === 'function' ? update(prev) : update));
    }, []);

    const [editingId, setEditingId] = useState<string>('');
    // Any filing in flight. Gates the auto-file effect so two passes can't race.
    const [isCategorizing, setIsCategorizing] = useState(false);
    const [isKeyboardVisible, setKeyboardVisible] = useState(false);
    const inputRefs = useRef<Record<string, TextInput | null>>({});

    // True from the moment a different week is selected until that week's first
    // snapshot lands. Distinct from the context's `isLoading`, which covers
    // fetching the set of weeks, not the contents of one.
    const [isListLoading, setIsListLoading] = useState(true);

    const [isSuggestionModalVisible, setSuggestionModalVisible] = useState(false);
    const [isCookbookModalVisible, setCookbookModalVisible] = useState(false);


    const [collapsedMeals, setCollapsedMeals] = useState<Record<string, boolean>>({});

    /**
     * Canonical keys of what this household keeps in. Fetched rather than
     * derived: the counting happens server-side as a side effect of saving a
     * list, because that is the only place the previous document exists.
     *
     * Refreshed on focus rather than after every save. Nothing visible changes
     * at the moment a staple is promoted — the row that promoted it has just
     * been deleted — so the effect is only ever seen on the NEXT list, and
     * refetching on save would be a request per keystroke-batch for nothing.
     */
    const [staples, setStaples] = useState<ReadonlySet<string>>(() => new Set());

    const [recipeToViewId, setRecipeToViewId] = useState<string | null>(null);
    // Carried alongside the id rather than looked up at render: the recipe is
    // opened from a meal, and the meal is what knows the factor its ingredients
    // were bought at.
    const [recipeToViewScale, setRecipeToViewScale] = useState(1);
    const [recipeToEdit, setRecipeToEdit] = useState<Meal | null>(null);

    const [isFabMenuOpen, setIsFabMenuOpen] = useState(false);
    const fabAnimation = useSharedValue(0);

    const [cookbookRecipeIds, setCookbookRecipeIds] = useState<Set<string>>(new Set());

    const hasCheckedForUnratedMeals = useRef(false);

    const [isFocused, setIsFocused] = useState(false);

    const listRef = useRef<GroceryListHandle | null>(null);

    // Bumped every time the user drags a row somewhere. Filing is a model call
    // and takes its time; an answer worked out before the drag would put the row
    // straight back, so one that comes home to a different number than it left
    // with is thrown away and asked for again.
    const reorderSeqRef = useRef(0);

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

    // When the user last touched the list. The only thing reading it is the
    // status pill, which stays quiet for the saves the app makes on its own
    // (rank repair, filing) and speaks up only for work the user did.
    //
    // This used to open a 1.2s window during which ANOTHER client's snapshot
    // was dropped on the floor rather than applied mid-keystroke. That window
    // is gone: snapshots are now merged field by field, so one landing while
    // you type cannot take the keystroke with it — you changed `text`, they
    // didn't, so yours wins outright with no appeal to a clock. Dropping
    // snapshots was always a guess, and it guessed wrong for anyone who kept
    // typing for longer than 1.2 seconds.
    const lastEditAtRef = useRef<number>(0);
    const markDirty = () => {
        lastEditAtRef.current = Date.now();
    };

    // Saving, retrying, merging and mirroring to disk all live in the engine.
    // It is keyed by list and OUTLIVES this screen, so edits made on a week the
    // user has since navigated away from still reach the server.
    //
    // Held as BOTH a ref and state: the ref is what the callbacks below reach
    // for (always current, never a stale closure), the state is what the status
    // bar re-renders on.
    const engineRef = useRef<ListSyncEngine | null>(null);
    const [engine, setEngine] = useState<ListSyncEngine | null>(null);

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


    // No saves until this list's state has actually been loaded — from disk or
    // from the server. Without it the first render, whose `items` is the empty
    // array this screen starts with, would be recorded as an edit that emptied
    // the week.
    //
    // The companion flag that used to sit here — "this change came from the
    // server, don't save it back" — is gone. The engine answers that by
    // comparing against the revision the server confirmed, which is a fact
    // rather than a flag that has to be set and cleared correctly around every
    // asynchronous apply.
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

    /**
     * Puts a snapshot on screen — from the socket, from a merge, or from the
     * on-device mirror. Never stamps: the raw setters are used deliberately, so
     * rows the other person edited do not come out looking like they were
     * edited here.
     */
    const renderSnapshot = useCallback((snapshot: { items?: Item[]; meals?: Meal[] }) => {
        if (!snapshot) return;
        hasLoadedRef.current = true;
        setIsListLoading(false);

        // Repair missing/invalid LexoRanks (e.g. legacy 'NEEDS-RANK' rows), and
        // read `items` in whichever shape RTDB stored it — an array with a hole
        // in it comes back as a keyed object, and demanding Array.isArray here
        // meant showing an empty list rather than the one we were sent.
        // Copied before sorting. `sanitizeListOrders` hands back the SAME array
        // when nothing needed repair, and `sort` mutates in place — so without
        // the spread this reorders the engine's own copy of the document as a
        // side effect of drawing it.
        const withOrder = [...sanitizeListOrders(snapshot.items)]
            .sort((a: Item, b: Item) => (a.listOrder ?? '').localeCompare(b.listOrder ?? ''));

        // An empty list is left empty. It used to be given a blank placeholder
        // row, which the grocery view renders as an unlabelled checkbox — one
        // more empty row to clean up, and one the user never asked for. The view
        // has a real empty state and offers to add the first item itself.
        setItemsRaw(withOrder);
        // `meals` can come back keyed too, for the same reason.
        setMealsRaw(asArray(snapshot.meals));
    }, []);

    // Handles ALL incoming data (Initial Fetch + Real-time Updates)
    useEffect(() => {
        if (!selectedList?.id || !selectedGroup?.id) {
            setItemsRaw([]);
            setMealsRaw([]);
            setIsListLoading(false);
            return;
        }
        hasLoadedRef.current = false;
        // Nothing on screen belongs to the week we are switching to. Holding on
        // to the previous list's items and meals until a snapshot arrives shows
        // one week's food under another week's heading, which reads as real
        // rather than as still loading.
        setItemsRaw([]);
        setMealsRaw([]);
        setIsListLoading(true);
        // These track ids on the list being left behind; the snapshot for the
        // new one decides its own state.
        sortFailedIdsRef.current = new Set();

        const engine = getListSyncEngine(selectedGroup.id, selectedList.id);
        engineRef.current = engine;
        setEngine(engine);

        // listenToList fetches an auth token before it opens the socket, so the
        // unsubscribe it hands back can arrive AFTER this effect has been torn
        // down. Waiting on the variable alone meant a week switched during that
        // window left the old socket open forever, and its snapshot landed on
        // top of the new week. The flag closes over the teardown instead.
        let cancelled = false;
        let unsubscribe: (() => void) | undefined;

        // The on-device mirror FIRST, before a token is fetched or a socket is
        // opened. This is the whole offline story in three lines: a phone with
        // no signal paints the real week immediately instead of a spinner over
        // an empty list that the tab layout would then replace with an error
        // screen. When there IS signal this loses nothing — the snapshot lands a
        // moment later and the engine reconciles it against exactly this state.
        engine.hydrate().then(cached => {
            if (cancelled) return;
            if (cached) {
                // A snapshot that arrived while the read was in flight is newer
                // than what came off disk; don't paint over it.
                if (!hasLoadedRef.current) renderSnapshot(cached);
                return;
            }
            // Nothing on disk for this week. Online, that is fine — the snapshot
            // is on its way. Offline it is not: no snapshot is coming, and the
            // spinner would stay up forever over a week the user opened for the
            // first time in a shop.
            //
            // So: stop waiting, and let them work. Marking it loaded means those
            // edits are captured and mirrored to disk, and it is safe to do
            // because the engine refuses to send anything until it has a
            // confirmed document to build on — the empty list on screen can
            // never be written over a week that actually has food in it.
            if (!isOnline() && !hasLoadedRef.current) {
                hasLoadedRef.current = true;
                setIsListLoading(false);
            }
        }).catch(err => console.warn('Failed to read cached list', err));

        // A merge can happen with no snapshot in sight — a queued offline save
        // finally going out and coming back 409. This is how its result reaches
        // the screen rather than only the disk.
        const unsetRenderer = engine.setRenderer(snapshot => {
            if (!cancelled) renderSnapshot(snapshot);
        });

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

                    // The engine decides what this snapshot means, because it is
                    // the only thing that knows what the server last confirmed:
                    // our own echo (adopt the revision, repaint nothing), a
                    // change to a list we have no unsaved edits on (adopt it), or
                    // a change that has to be merged with edits made here —
                    // including edits made with no signal at all, minutes ago.
                    //
                    // It returns what should now be on screen, or null when the
                    // answer is "nothing you don't already have".
                    const next = engine.applyRemote(list, CLIENT_ID);
                    hasLoadedRef.current = true;
                    setIsListLoading(false);
                    if (next) renderSnapshot(next);
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
            unsetRenderer();
            unsubscribe?.();
            // Deliberately NOT stopping the engine. It keeps whatever this week
            // still owes the server and keeps trying — leaving a week with
            // unsaved edits is not the same as abandoning them.
        };
        // Depend on stable IDs: presence updates re-create the group object and
        // would otherwise tear the socket down on every status change.
    }, [selectedList?.id, selectedGroup?.id, renderSnapshot]);

    // Handles ALL outgoing data.
    //
    // This is now one line, because everything that used to be here — the
    // debounce, the revision bookkeeping, the 409 handling — belongs to the
    // engine, and belongs there rather than in a component effect for a
    // concrete reason: an effect dies with the screen. It could only ever save
    // the week being looked at, and only while it was being looked at. A save
    // that failed because the phone was in a chest freezer aisle had nowhere to
    // live until the signal came back.
    //
    // Note there is no "did this change come from the server" guard any more.
    // The engine compares against the revision the server confirmed, so a state
    // that merely reflects what the server already has is not recorded as an
    // edit, whoever produced it.
    useEffect(() => {
        if (!hasLoadedRef.current) return;
        engineRef.current?.recordLocal({ items, meals });
    }, [items, meals]);

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
            const groupId = selectedGroup?.id;
            if (!groupId) {
                setStaples(new Set());
                return;
            }
            let ignore = false;
            // getStaples never rejects — an unreachable API and a household
            // with no staples yet both render exactly today's list.
            getStaples(groupId).then(entries => {
                if (!ignore) setStaples(new Set(entries.map(e => e.key)));
            });
            return () => { ignore = true; };
        }, [selectedGroup?.id])
    );

    /**
     * Appends last week's unbought rows to this week's list.
     *
     * Ranked here rather than in the banner because this is where the rest of
     * the list is: `nextListRank` needs every existing row to put these after
     * all of them, and a rank generated against a stale snapshot lands them in
     * the middle of somebody's aisles.
     */
    const handleCarryOver = useCallback((rows: Omit<Item, 'id' | 'listOrder'>[]) => {
        if (rows.length === 0) return;
        setItems(prev => {
            let rank = nextListRank(prev);
            const carried = rows.map(row => {
                rank = rank.genNext();
                return { ...row, id: uuid.v4() as string, listOrder: rank.toString() } as Item;
            });
            // A brand new week is one blank row waiting for text. Carrying rows
            // in on top of it leaves an empty checkbox above them.
            const isSingleEmpty = prev.length === 1 && !prev[0].isSection && (prev[0].text ?? '') === '';
            return isSingleEmpty ? carried : [...prev, ...carried];
        });
        markDirty();
    }, [markDirty]);

    /**
     * "I do buy this." Optimistic: the row is already back on the list by the
     * time this runs (GroceryListView promotes it first), so all that is left
     * is to stop the server saying it again.
     */
    const handleAlwaysShowStaple = useCallback(async (key: string, name: string) => {
        const groupId = selectedGroup?.id;
        if (!groupId) return;
        setStaples(prev => {
            const next = new Set(prev);
            next.delete(key);
            return next;
        });
        try {
            await alwaysShowStaple(groupId, key);
        } catch (error) {
            console.error(`Failed to always-show staple ${name}:`, error);
            // Left promoted locally on purpose. The row the user asked for is
            // on their list, which is what they wanted; the worst case is that
            // it is filed away again on the next list, where one more tap fixes
            // it. Putting it back in the strip now would undo a deliberate
            // action in front of them.
        }
    }, [selectedGroup?.id]);

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

    // Always called with a meal from here: the editor is only ever opened on
    // one. The cookbook opens the same form with no meal at all.
    const handleRecipeSaved = (updatedMeal: Meal | null, newItems: Item[]) => {
        if (!updatedMeal) return;
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
        setRecipeToViewScale(meal.scale ?? 1);
        setRecipeToViewId(meal.recipeId);
    };


    const handleAddRecipe = (meal: Meal) => setRecipeToEdit(meal);

    const handleAddMealsFromSuggestion = (newMeals: Meal[], newItemsFromModal: Item[]) => {
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

        // 3. Send the new, still-unsorted items immediately rather than waiting
        // out the debounce — these came from a modal the user has just
        // dismissed, and a whole meal plan is a lot to lose. The auto-sort
        // effect files them into departments once the state above has committed.
        //
        // No try/catch and no error alert. Recording is synchronous and writes
        // to disk before it writes to the network, so there is nothing here that
        // can fail in a way the user needs telling about: if the send doesn't go
        // through, the plan is already mirrored on the device and the engine
        // keeps trying. Telling someone their meal plan failed to save when it
        // is sitting safely on their phone is worse than saying nothing.
        const engine = engineRef.current;
        if (engine) {
            engine.recordLocal({ items: finalNewItems, meals: updatedMeals });
            void engine.flush();
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
     * Files the named items into supermarket aisles.
     *
     * Only those rows move; the rest of the list is left exactly as it is, which
     * is what lets a row the user has dragged somewhere stay dragged. There is
     * no whole-list re-sort any more — department order is not a mode to switch
     * into, it is just what the list does.
     */
    const handleAutoCategorize = async (itemIds: string[]) => {
        if (!selectedGroup || !selectedList?.id) return;
        setIsCategorizing(true);
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
        // ...and the order it will be about. See reorderSeqRef.
        const askedForOrder = reorderSeqRef.current;

        try {
            const { items: newItems, rev } = await categorizeList(selectedGroup.id, selectedList.id, currentItems, itemIds);
            if (selectedListIdRef.current !== askedForListId) return;
            // The user moved a row by hand while this was in flight. The answer
            // carries a rank for every row, worked out from where they all were
            // before that move, so applying it would undo the move. Drop it —
            // `items` has changed, so the effect below asks again with the order
            // the user has just set.
            if (reorderSeqRef.current !== askedForOrder) return;
            // Adopt the server's document as the confirmed base BEFORE merging
            // it into local state. Categorize commits its own revision, so
            // without this the next save arrives stale and is merged against a
            // document it already agrees with — work for nothing, and a
            // needless broadcast to everyone else in the group.
            //
            // `meals` are untouched by filing, so the server's document is its
            // items plus the meals we already hold.
            const filed = sanitizeListOrders(newItems);
            engineRef.current?.adoptServerWrite({ items: filed, meals }, rev);
            applyFiledItems(filed);
            sortFailedIdsRef.current = new Set();
        } catch (err) {
            console.error('Auto-categorization failed', err);
            if (selectedListIdRef.current !== askedForListId) return;
            // Give up on these particular items until something else changes,
            // so the auto-sort effect doesn't retry them on every render.
            for (const id of itemIds) sortFailedIdsRef.current.add(id);
        } finally {
            setIsCategorizing(false);
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
        if (unsortedIds.length === 0) return;
        if (isCategorizing) return;
        if (!hasLoadedRef.current || !selectedGroup || !selectedList?.id) return;

        // Long enough that typing a run of items costs one call, not one per
        // item, and short enough to feel like the list is filing itself.
        const timer = setTimeout(() => { handleAutoCategorize(unsortedIds).catch(console.error); }, 700);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [unsortedKey, isCategorizing, items, selectedGroup?.id, selectedList?.id]);

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
    }, [items, editingId, isKeyboardVisible, setItems]);

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
                <SyncStatus engine={engine} />
                {selectedView == ListView.GroceryList && (
                    <CarryOverBanner
                        groupId={selectedGroup?.id}
                        currentList={selectedList}
                        allLists={allLists}
                        onCarryOver={handleCarryOver}
                    />
                )}
                { selectedView == ListView.GroceryList ? (
                    <GroceryListView
                        items={items}
                        setItems={setItems}
                        editingId={editingId}
                        setEditingId={setEditingId}
                        inputRefs={inputRefs}
                        isKeyboardVisible={isKeyboardVisible}
                        markDirty={markDirty}
                        onManualReorder={() => { reorderSeqRef.current += 1; }}
                        staples={staples}
                        onAlwaysShowStaple={handleAlwaysShowStaple}
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
                scale={recipeToViewScale}
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
    bottomActionContainer: {
        position: 'absolute',
        bottom: 30,
        paddingHorizontal: 20,
        width: '100%',
        flexDirection: 'row',
        // The FAB is the only thing left down here now that sorting is not a
        // choice to make; space-between would park it on the left.
        justifyContent: 'flex-end',
        alignItems: 'flex-end',
        gap: 16
    },
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
});