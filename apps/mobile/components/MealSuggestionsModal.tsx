import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Keyboard,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import uuid from 'react-native-uuid';

import LeftoversModeModal from '@/components/LeftoversModeModal';
import { useAuth } from '@/context/AuthContext';
import { usePro } from '@/context/ProContext';
import { Item, Meal, MealPreferences, Recipe, SuggestionTurn } from '@/types/types';
import { leftoversScanNotice } from '@/utils/leftovers';
import {
    accountStatusFromUnknown,
    aiUsageFromUnknown,
    formatResetLabel,
    isCurrentUsageWindowExhausted,
    quotaGateAfterRefresh,
    usageNotice,
} from '@/utils/pro';
import { scaleIngredients, servingsScale } from '@/utils/servings';
import { ink, inkMuted, primary } from '@/utils/styles';
import { GlassPressable, GlassSurface, useGlassPreferences } from '@/components/ui/Glass';
import { ApiError, getMealPreferences, getMealSuggestions, saveRecipe } from '../utils/api';

interface SuggestionModalProps {
    isVisible: boolean;
    onClose: () => void;
    onAddSelectedMeals: (newMeals: Meal[], newItems: Item[]) => void;
    listId: string;
}

/**
 * Offered at generation time rather than saved to the profile. What you feel
 * like eating belongs to the evening, not to you — saved globally, one pick of
 * "Thai" quietly steered every suggestion from then on.
 */
const HINT_GROUPS: { label: string; tags: string[] }[] = [
    {
        label: 'Mood',
        tags: ['Quick & Easy', 'Comfort Food', 'Healthy & Light', 'Family Friendly', 'Budget-Friendly', 'Adventurous', 'Use up leftovers'],
    },
    {
        label: 'Cuisine',
        tags: ['Italian', 'Mexican', 'Mediterranean', 'Indian', 'Thai', 'Japanese', 'Chinese', 'Korean', 'Middle Eastern', 'French', 'Greek'],
    },
];

/** One entry in the visible conversation. */
type Bubble =
    | { id: string; role: 'user'; kind: 'text'; text: string }
    | { id: string; role: 'assistant'; kind: 'text'; text: string }
    | { id: string; role: 'assistant'; kind: 'suggestions'; recipes: Recipe[] };

/** The sheet's own bottom padding, before the home indicator is accounted for. */
const SHEET_BOTTOM_PAD = 12;

/**
 * What a re-roll says, in the transcript and to the model alike — one string so
 * the conversation the model is replayed matches the one on screen.
 */
const REROLL_ASK = 'None of those — show me three different ones.';

const LOADING_MESSAGES = [
    'Consulting our chefs...',
    'Rummaging through the pantry...',
    'Asking grandma for her secret recipe...',
    'Warming up the oven...',
];

export default function MealSuggestionsModal({ isVisible, onClose, onAddSelectedMeals, listId }: SuggestionModalProps) {
    const { reduceMotion } = useGlassPreferences();
    const { selectedGroup } = useAuth();
    const {
        isPro,
        isLoading: isLoadingPro,
        status,
        usage,
        refresh: refreshPro,
        applyAccountStatus,
        applyAiUsage,
    } = usePro();
    const [prefs, setPrefs] = useState<MealPreferences | null>(null);
    const [isLoadingPrefs, setIsLoadingPrefs] = useState(true);

    const [transcript, setTranscript] = useState<Bubble[]>([]);
    const [input, setInput] = useState('');
    const [selectedHints, setSelectedHints] = useState<string[]>([]);
    const [isLeftoversVisible, setIsLeftoversVisible] = useState(false);
    const [leftoversIngredients, setLeftoversIngredients] = useState<string[]>([]);

    // Preferences the user has switched off FOR THIS SHEET ONLY. Nothing here is
    // ever written back — closing the sheet restores the saved profile.
    const [disabledNeeds, setDisabledNeeds] = useState<string[]>([]);
    const [dislikesOff, setDislikesOff] = useState(false);

    const [isSuggesting, setIsSuggesting] = useState(false);
    const [isCheckingQuota, setIsCheckingQuota] = useState(false);
    const [isAddingSelected, setIsAddingSelected] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState(LOADING_MESSAGES[0]);
    const [selectedSuggestions, setSelectedSuggestions] = useState<Record<string, boolean>>({});
    // Titles already shown this session, so a follow-up doesn't repeat them.
    const [vetoedMeals, setVetoedMeals] = useState<string[]>([]);
    // The terms of the last ask. Sending clears the composer and the chips, so
    // without this a re-roll would have nothing left to ask again on.
    const [lastAsk, setLastAsk] = useState<{ query: string; hints: string[]; leftoversIngredients: string[] }>({
        query: '', hints: [], leftoversIngredients: [],
    });

    const scrollRef = useRef<ScrollView | null>(null);
    const pendingNavigation = useRef<'quota' | 'leftovers' | 'sign-in' | null>(null);
    const onCloseRef = useRef(onClose);
    const isVisibleRef = useRef(isVisible);
    const suggestionSession = useRef(0);
    const suggestionBusy = useRef(false);
    const addSelectedBusy = useRef(false);
    const suggestionAbort = useRef<AbortController | null>(null);
    const router = useRouter();
    onCloseRef.current = onClose;
    isVisibleRef.current = isVisible;

    const invalidateSuggestionSession = useCallback((updateUi = true) => {
        suggestionSession.current += 1;
        suggestionBusy.current = false;
        suggestionAbort.current?.abort();
        suggestionAbort.current = null;
        if (updateUi) {
            setIsCheckingQuota(false);
            setIsSuggesting(false);
        }
    }, []);

    const closeSuggestionModal = useCallback(() => {
        invalidateSuggestionSession();
        onCloseRef.current();
    }, [invalidateSuggestionSession]);

    // The composer sits at the bottom of the screen, where on a modern iPhone
    // the home indicator and the display's rounded corners both are. Without
    // the inset it renders into both.
    const insets = useSafeAreaInsets();
    // ...but the keyboard covers that area when it's up, and the avoider above
    // already lifts the sheet clear of it, so the inset would then just be a gap.
    const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
    const bottomPad = isKeyboardOpen ? SHEET_BOTTOM_PAD : Math.max(insets.bottom, SHEET_BOTTOM_PAD);

    useEffect(() => {
        // `will` on iOS so the padding moves with the keyboard's own animation
        // rather than snapping a frame after it has finished.
        const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
        const show = Keyboard.addListener(showEvent, () => setIsKeyboardOpen(true));
        const hide = Keyboard.addListener(hideEvent, () => setIsKeyboardOpen(false));
        return () => { show.remove(); hide.remove(); };
    }, []);

    const activeNeeds = useMemo(
        () => (prefs?.dietaryNeeds ?? []).filter(n => !disabledNeeds.includes(n)),
        [prefs?.dietaryNeeds, disabledNeeds],
    );
    const activeDislikes = dislikesOff ? '' : (prefs?.dislikedIngredients ?? '');
    const hasSavedPrefs = !!(prefs?.dietaryNeeds?.length || prefs?.dislikedIngredients);
    const anythingDisabled = disabledNeeds.length > 0 || dislikesOff;

    // Cycle the loading copy while a request is in flight.
    useEffect(() => {
        if (!isSuggesting) return;
        let i = 0;
        setLoadingMessage(LOADING_MESSAGES[0]);
        const id = setInterval(() => {
            i += 1;
            if (i < LOADING_MESSAGES.length) setLoadingMessage(LOADING_MESSAGES[i]);
            else clearInterval(id);
        }, 4000);
        return () => clearInterval(id);
    }, [isSuggesting]);

    useEffect(() => {
        invalidateSuggestionSession();
        if (!isVisible) return undefined;
        const session = suggestionSession.current;
        let cancelled = false;
        const isCurrentSession = () => !cancelled && suggestionSession.current === session;

        // Every open starts a fresh conversation, and a fresh set of temporary
        // overrides — a preference switched off last night must not still be off
        // tonight.
        setTranscript([]);
        setInput('');
        setSelectedHints([]);
        setIsLeftoversVisible(false);
        setLeftoversIngredients([]);
        setDisabledNeeds([]);
        setDislikesOff(false);
        setSelectedSuggestions({});
        setVetoedMeals([]);
        setLastAsk({ query: '', hints: [], leftoversIngredients: [] });

        const fetchPreferences = async () => {
            setIsLoadingPrefs(true);
            try {
                const loaded = await getMealPreferences();
                if (!isCurrentSession()) return;
                setPrefs(loaded);
            } catch (error) {
                if (!isCurrentSession()) return;
                if (error instanceof ApiError && error.status === 404) {
                    // First run: send them to set the everyday baseline, and come
                    // back here afterwards.
                    try {
                        await AsyncStorage.setItem('pendingAction', 'suggest-meals');
                    } catch (storageError) {
                        console.error('Could not preserve the Suggest Meals preferences intent:', storageError);
                    }
                    if (!isCurrentSession()) return;
                    closeSuggestionModal();
                    router.navigate('/meal-preferences');
                    return;
                }
                console.error('Failed to fetch meal preferences:', error);
                closeSuggestionModal();
                Alert.alert('Error', 'Could not load your meal preferences. Please try again.');
                return;
            } finally {
                if (isCurrentSession()) setIsLoadingPrefs(false);
            }
        };

        // Reconcile the visible allowance whenever this sheet opens. Success
        // headers keep the counter exact after this device generates, while
        // this refresh catches suggestions used on another signed-in device.
        void refreshPro();
        void fetchPreferences();
        return () => {
            cancelled = true;
            if (suggestionSession.current === session) invalidateSuggestionSession(false);
        };
    }, [closeSuggestionModal, invalidateSuggestionSession, isVisible, refreshPro, router]);

    const push = (bubble: Bubble) => setTranscript(prev => [...prev, bubble]);

    const flushPendingPaywall = () => {
        const source = pendingNavigation.current;
        if (!source) return;
        pendingNavigation.current = null;
        if (source === 'sign-in') {
            router.push({ pathname: '/login', params: { returnTo: 'suggest-meals' } });
            return;
        }
        router.push({ pathname: '/pro', params: { source } });
    };

    const openPaywall = (source: 'quota' | 'leftovers') => {
        // Presenting a routed screen while this native Modal is still leaving
        // can put the paywall behind it on iOS. Queue the destination and let
        // onDismiss perform the push once the sheet is actually gone.
        pendingNavigation.current = source;
        setIsLeftoversVisible(false);
        closeSuggestionModal();
        if (Platform.OS !== 'ios') setTimeout(flushPendingPaywall, 0);
    };

    const openSuggestionSignIn = async (session: number) => {
        try {
            await AsyncStorage.setItem('pendingAction', 'suggest-meals');
        } catch (error) {
            // Sign-in is still the useful recovery even if the convenience
            // reopen marker could not be written.
            console.error('Could not preserve the Suggest Meals sign-in intent:', error);
        }
        if (!isSuggestionOperationCurrent(session)) return;
        pendingNavigation.current = 'sign-in';
        setIsLeftoversVisible(false);
        closeSuggestionModal();
        if (Platform.OS !== 'ios') setTimeout(flushPendingPaywall, 0);
    };

    const handleLeftoversProRequired = async (session: number) => {
        // A server 403 outranks the locally cached entitlement. Refresh before
        // routing so the paywall cannot briefly render an obsolete active plan.
        await refreshPro();
        if (suggestionSession.current !== session || !isVisibleRef.current) return;
        openPaywall('leftovers');
    };

    const isSuggestionOperationCurrent = (session: number): boolean =>
        suggestionBusy.current && suggestionSession.current === session;

    const runSuggestionFlow = async (
        task: (session: number) => Promise<void>,
    ): Promise<void> => {
        // The ref closes the gap before React can render disabled buttons. A
        // second tap in the same frame cannot start another quota reservation.
        if (!isVisible || isLoadingPrefs || suggestionBusy.current || addSelectedBusy.current) return;
        const session = suggestionSession.current;
        suggestionBusy.current = true;
        setIsCheckingQuota(true);
        try {
            await task(session);
        } finally {
            if (isSuggestionOperationCurrent(session)) {
                suggestionBusy.current = false;
                setIsCheckingQuota(false);
                setIsSuggesting(false);
            }
        }
    };

    /** Prevent a known-exhausted request while still relying on the server as
     * the authority for races and stale counters. */
    const stopAtKnownQuotaWall = async (session: number): Promise<boolean> => {
        if (!usage || !isCurrentUsageWindowExhausted(usage)) return false;
        // Zero may include another device's in-flight reservation. Provider
        // failures refund that reservation, so only a fresh snapshot is safe
        // to use as a local hard wall.
        const refreshed = await refreshPro();
        if (!isSuggestionOperationCurrent(session)) return true;
        const decision = quotaGateAfterRefresh(refreshed, 'suggestions');
        if (decision.kind === 'allow') return false;
        if (decision.kind === 'pro-required' || !decision.isPro) {
            openPaywall('quota');
        } else {
            const notice = usageNotice(decision.usage, true);
            Alert.alert(notice.title, notice.reset);
        }
        return true;
    };

    /**
     * Replays the visible conversation for the model. Suggestion sets go back as
     * their titles: enough for "more like the second one" to mean something,
     * without posting three full recipes back up the wire.
     */
    const conversationForApi = (): SuggestionTurn[] =>
        transcript
            .map<SuggestionTurn | null>(b => {
                if (b.kind === 'suggestions') {
                    return { role: 'assistant', text: b.recipes.map(r => r.name).join(', ') };
                }
                if (b.role === 'user') return { role: 'user', text: b.text };
                // Assistant prose is our own error copy, not something the model
                // said — replaying it would teach it to apologise.
                return null;
            })
            .filter((t): t is SuggestionTurn => t !== null);

    /**
     * One request, however it was asked for.
     *
     * `spoken` is what goes in the transcript; `query`/`hints` are the terms the
     * model is steered by. They differ for a re-roll, whose ask ("none of
     * those") is a refinement of the brief rather than the brief itself — so it
     * travels as `extraTurns` while the original brief still travels as `query`.
     */
    const requestSuggestions = async (ask: {
        spoken: string;
        query: string;
        hints: string[];
        leftoversIngredients?: string[];
        extraTurns?: SuggestionTurn[];
    }, session: number) => {
        if (!isSuggestionOperationCurrent(session)) return;
        push({ id: uuid.v4() as string, role: 'user', kind: 'text', text: ask.spoken });

        // Read before the push above has committed, which is what keeps the turn
        // being made now from also arriving as history.
        const conversation = [...conversationForApi(), ...(ask.extraTurns ?? [])];

        // Deliberately NOT clearing selections: earlier sets stay on screen and
        // stay tickable, so asking for more must not silently drop the dish they
        // already picked.
        setIsCheckingQuota(false);
        setIsSuggesting(true);
        const abortController = new AbortController();
        suggestionAbort.current = abortController;

        try {
            const response = await getMealSuggestions({
                vetoedTitles: vetoedMeals,
                // Always sent, so what the chips show is exactly what applies.
                overrides: { dietaryNeeds: activeNeeds, dislikedIngredients: activeDislikes },
                hints: ask.hints,
                leftoversIngredients: ask.leftoversIngredients,
                query: ask.query,
                conversation,
            }, abortController.signal);
            if (!isSuggestionOperationCurrent(session)) return;
            if (response.aiUsage) applyAiUsage(response.aiUsage);

            const withIds = response.recipes.map(r => ({ ...r, id: uuid.v4() as string }));
            setVetoedMeals(prev => [...prev, ...withIds.map(r => r.name)]);
            push({ id: uuid.v4() as string, role: 'assistant', kind: 'suggestions', recipes: withIds });
        } catch (error) {
            if (!isSuggestionOperationCurrent(session)) return;
            console.error('Meal suggestion failed:', error);
            if (error instanceof ApiError && error.status === 403 && error.code === 'account_required') {
                await openSuggestionSignIn(session);
                return;
            }
            if (error instanceof ApiError && error.status === 429 && error.code === 'ai_quota_exceeded') {
                const responseStatus = accountStatusFromUnknown(error.data);
                const errorBody = error.data && typeof error.data === 'object'
                    ? error.data as { aiUsage?: unknown }
                    : null;
                const responseUsage = responseStatus?.aiUsage ?? aiUsageFromUnknown(errorBody?.aiUsage);
                if (responseStatus) applyAccountStatus(responseStatus);
                else if (responseUsage) applyAiUsage(responseUsage);

                if (responseStatus && !responseStatus.isPro) {
                    openPaywall('quota');
                } else {
                    const reset = responseUsage
                        ? formatResetLabel(responseUsage.windowEndsAt)
                        : 'It will reset automatically';
                    push({
                        id: uuid.v4() as string,
                        role: 'assistant',
                        kind: 'text',
                        text: responseStatus?.isPro
                            ? `Your current fair-use allowance is used up. ${reset}.`
                            : `Your weekly suggestion allowance is used up. ${reset}.`,
                    });
                }
                return;
            }
            if (error instanceof ApiError && error.status === 429 && error.code === 'ai_attempt_rate_exceeded') {
                const attemptUsage = error.data && typeof error.data === 'object'
                    ? (error.data as { attemptUsage?: unknown }).attemptUsage
                    : null;
                const windowEndsAt = attemptUsage && typeof attemptUsage === 'object'
                    ? (attemptUsage as { windowEndsAt?: unknown }).windowEndsAt
                    : null;
                const reset = typeof windowEndsAt === 'string'
                    ? formatResetLabel(windowEndsAt)
                    : 'Try again in a little while';
                push({
                    id: uuid.v4() as string,
                    role: 'assistant',
                    kind: 'text',
                    text: `${error.message} ${reset}.`,
                });
                return;
            }
            push({
                id: uuid.v4() as string,
                role: 'assistant',
                kind: 'text',
                text: "That didn't work. Try again, or change what you're asking for.",
            });
        } finally {
            if (suggestionAbort.current === abortController) suggestionAbort.current = null;
            if (isSuggestionOperationCurrent(session)) {
                setIsSuggesting(false);
                // The response was either finalized or refunded server-side.
                // Reconcile all plan state instead of guessing which happened.
                void refreshPro();
            }
        }
    };

    const generate = async () => {
        await runSuggestionFlow(async session => {
            // The overrides sent below are built from `prefs`. The flow lock is
            // acquired before any refresh so rapid taps cannot double-reserve.
            if (await stopAtKnownQuotaWall(session)) return;
            if (!isSuggestionOperationCurrent(session)) return;

            const query = input.trim();
            const hints = selectedHints;

            setLastAsk({ query, hints, leftoversIngredients });
            setInput('');
            setSelectedHints([]);

            // Echo what was asked for, so the transcript reads as a conversation
            // even when they tapped send with nothing typed.
            const spoken = [query, hints.length ? hints.join(', ') : ''].filter(Boolean).join(' · ');
            await requestSuggestions({
                spoken: spoken || (leftoversIngredients.length ? 'Suggest meals from my confirmed ingredients' : 'Suggest 3 dinners'),
                query,
                hints,
                leftoversIngredients,
            }, session);
        });
    };

    /**
     * Three more, on the same brief. The query and hints of the last ask go back
     * unchanged, so the mood, cuisine and typed request still apply; what makes
     * the next three different is `vetoedMeals`, which by now holds every title
     * shown this session and reaches the model as "do not repeat or closely
     * echo". The dietary chips are re-read at send time, as for any other ask.
     */
    const reroll = async () => {
        await runSuggestionFlow(async session => {
            if (await stopAtKnownQuotaWall(session)) return;
            if (!isSuggestionOperationCurrent(session)) return;
            await requestSuggestions({
                spoken: REROLL_ASK,
                query: lastAsk.query,
                hints: lastAsk.hints,
                leftoversIngredients: lastAsk.leftoversIngredients,
                extraTurns: [{ role: 'user', text: REROLL_ASK }],
            }, session);
        });
    };

    const openLeftovers = async () => {
        if (isLoadingPro || isLoadingPrefs) return;
        if (!isPro) {
            openPaywall('leftovers');
            return;
        }
        await runSuggestionFlow(async session => {
            if (await stopAtKnownQuotaWall(session)) return;
            if (!isSuggestionOperationCurrent(session)) return;

            const cachedScanUsage = status?.leftoversScanUsage;
            if (cachedScanUsage && isCurrentUsageWindowExhausted(cachedScanUsage)) {
                const refreshed = await refreshPro();
                if (!isSuggestionOperationCurrent(session)) return;
                const decision = quotaGateAfterRefresh(refreshed, 'leftovers');
                if (decision.kind === 'pro-required') {
                    openPaywall('leftovers');
                    return;
                }
                if (decision.kind === 'quota-exhausted') {
                    const notice = leftoversScanNotice(decision.usage);
                    Alert.alert(notice.title, notice.reset);
                    return;
                }
                // Refresh failures deliberately continue. The scan endpoint is
                // authoritative and may reveal that a reservation was refunded.
            }
            if (isSuggestionOperationCurrent(session)) setIsLeftoversVisible(true);
        });
    };

    const describeLeftovers = (ingredients: string[]): string => {
        const shown = ingredients.slice(0, 5).join(', ');
        const more = ingredients.length - 5;
        return `Use what I have: ${shown}${more > 0 ? `, and ${more} more` : ''}`;
    };

    const useConfirmedLeftovers = async (ingredients: string[]) => {
        await runSuggestionFlow(async session => {
            if (await stopAtKnownQuotaWall(session)) return;
            if (!isSuggestionOperationCurrent(session)) return;
            const hints = ['Use up leftovers'];
            setLeftoversIngredients(ingredients);
            setLastAsk({ query: '', hints, leftoversIngredients: ingredients });
            setSelectedHints([]);
            setInput('');
            // Close the photo flow immediately; the ordinary suggestion loading
            // bubble is the right place to wait for the recipe request itself.
            setIsLeftoversVisible(false);
            await requestSuggestions({
                spoken: describeLeftovers(ingredients),
                query: '',
                hints,
                leftoversIngredients: ingredients,
            }, session);
        });
    };

    const toggleHint = (tag: string) =>
        setSelectedHints(prev => (prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]));

    const toggleNeed = (need: string) =>
        setDisabledNeeds(prev => (prev.includes(need) ? prev.filter(n => n !== need) : [...prev, need]));

    const toggleSuggestion = (recipeId: string) =>
        setSelectedSuggestions(prev => ({ ...prev, [recipeId]: !prev[recipeId] }));

    const handleEditPreferences = async () => {
        try {
            await AsyncStorage.setItem('pendingAction', 'suggest-meals');
        } catch (error) {
            console.error('Could not preserve the Suggest Meals preferences intent:', error);
        }
        closeSuggestionModal();
        router.navigate('/meal-preferences');
    };

    const allSuggested = useMemo(
        () => transcript.flatMap(b => (b.kind === 'suggestions' ? b.recipes : [])),
        [transcript],
    );
    const selectedCount = allSuggested.filter(r => selectedSuggestions[r.id]).length;
    const currentUsageNotice = usage ? usageNotice(usage, isPro) : null;
    const isSuggestionFlowBusy = isCheckingQuota || isSuggesting;
    const isInteractionBusy = isSuggestionFlowBusy || isAddingSelected;

    // Only the newest set offers a re-roll. Older ones stay on screen and stay
    // tickable, but re-rolling them is meaningless — a re-roll asks for what
    // comes next, not for a set from three asks ago to be redone.
    const lastSuggestionId = useMemo(() => {
        for (let i = transcript.length - 1; i >= 0; i -= 1) {
            if (transcript[i].kind === 'suggestions') return transcript[i].id;
        }
        return null;
    }, [transcript]);

    const handleAddSelectedMeals = async () => {
        if (addSelectedBusy.current || suggestionBusy.current) return;
        const session = suggestionSession.current;
        addSelectedBusy.current = true;
        setIsAddingSelected(true);
        const chosen = allSuggested.filter(r => selectedSuggestions[r.id]);

        try {
            if (chosen.length === 0) return;
            const saved = await Promise.all(chosen.map(recipe => saveRecipe(recipe)));
            if (suggestionSession.current !== session || !isVisibleRef.current) return;

            const newMeals: Meal[] = [];
            const newItems: Item[] = [];

            for (const recipe of saved) {
                // Scaled on the way to the list, never in the saved recipe —
                // the recipe was written for `recipe.servings` and still says
                // so. See packages/shared/servings.ts.
                const scale = servingsScale(recipe.servings, selectedGroup?.householdSize);

                const newMeal: Meal = {
                    id: uuid.v4() as string,
                    listId,
                    name: recipe.name,
                    recipeId: recipe.id,
                };
                if (scale !== 1) newMeal.scale = scale;
                newMeals.push(newMeal);

                for (const ingredient of scaleIngredients(recipe.ingredients, scale)) {
                    newItems.push({
                        id: uuid.v4() as string,
                        text: ingredient.name.trim(),
                        quantity: (ingredient.quantity ?? '').trim(),
                        checked: false,
                        listOrder: 'NEEDS-RANK', // Parent assigns the real rank.
                        isSection: false,
                        mealId: newMeal.id,
                    });
                }
            }

            onAddSelectedMeals(newMeals, newItems);
        } catch (error) {
            if (suggestionSession.current !== session || !isVisibleRef.current) return;
            console.error('Failed to add selected meals:', error);
            Alert.alert('Error', 'Could not add the selected meals. Please try again.');
        } finally {
            const shouldClose = suggestionSession.current === session && isVisibleRef.current;
            addSelectedBusy.current = false;
            setIsAddingSelected(false);
            if (shouldClose) closeSuggestionModal();
        }
    };

    return (
        <Modal
            animationType={reduceMotion ? "none" : "slide"}
            transparent
            visible={isVisible}
            onRequestClose={() => isLeftoversVisible ? setIsLeftoversVisible(false) : closeSuggestionModal()}
            onDismiss={flushPendingPaywall}
        >
            <View style={styles.modalRoot}>
                {/* Full-screen avoider around a bottom sheet with a composer in it —
                    see AddEditRecipeModal for why this has to wrap the sheet rather
                    than be the sheet. */}
                <KeyboardAvoidingView
                    style={styles.overlay}
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                >
                    <Pressable style={styles.backdrop} onPress={closeSuggestionModal} />
                    <View style={[styles.sheet, { paddingBottom: bottomPad }]}>
                    <GlassSurface style={styles.header} intensity={70}>
                        <View style={{ width: 28 }} />
                        <Text style={styles.headerTitle}>Suggest Meals</Text>
                        <GlassPressable onPress={closeSuggestionModal} style={styles.closeButton} accessibilityLabel="Close meal suggestions">
                            <Ionicons name="close" size={21} color={ink} />
                        </GlassPressable>
                    </GlassSurface>

                    {/* What will actually be applied, and the one-tap way to drop
                        it for tonight only. */}
                    <View style={styles.prefsBar}>
                        <View style={styles.prefsBarHeader}>
                            <Text style={styles.prefsBarLabel}>
                                {hasSavedPrefs ? 'Applying' : 'No saved preferences'}
                            </Text>
                            <GlassPressable onPress={handleEditPreferences} hitSlop={8}>
                                <Text style={styles.prefsBarEdit}>Edit saved</Text>
                            </GlassPressable>
                        </View>

                        {isLoadingPrefs ? (
                            <ActivityIndicator size="small" style={{ alignSelf: 'flex-start', marginTop: 4 }} />
                        ) : (
                            <View style={styles.chipRow}>
                                {(prefs?.dietaryNeeds ?? []).map(need => {
                                    const off = disabledNeeds.includes(need);
                                    return (
                                        <GlassPressable
                                            key={need}
                                            style={[styles.prefChip, off && styles.prefChipOff]}
                                            onPress={() => toggleNeed(need)}
                                            accessibilityState={{ selected: !off }}
                                            accessibilityLabel={`${need} dietary preference`}
                                        >
                                            <Text style={[styles.prefChipText, off && styles.prefChipTextOff]}>{need}</Text>
                                            <Ionicons
                                                name={off ? 'add-circle-outline' : 'close-circle'}
                                                size={15}
                                                color={off ? '#aaa' : '#fff'}
                                                style={{ marginLeft: 5 }}
                                            />
                                        </GlassPressable>
                                    );
                                })}
                                {!!prefs?.dislikedIngredients && (
                                    <GlassPressable
                                        style={[styles.prefChip, dislikesOff && styles.prefChipOff]}
                                        onPress={() => setDislikesOff(v => !v)}
                                        accessibilityState={{ selected: !dislikesOff }}
                                    >
                                        <Text
                                            style={[styles.prefChipText, dislikesOff && styles.prefChipTextOff]}
                                            numberOfLines={1}
                                        >
                                            No {prefs.dislikedIngredients}
                                        </Text>
                                        <Ionicons
                                            name={dislikesOff ? 'add-circle-outline' : 'close-circle'}
                                            size={15}
                                            color={dislikesOff ? '#aaa' : '#fff'}
                                            style={{ marginLeft: 5 }}
                                        />
                                    </GlassPressable>
                                )}
                                {!hasSavedPrefs && (
                                    <Text style={styles.prefsEmpty}>Anything goes — just ask below.</Text>
                                )}
                            </View>
                        )}

                        {anythingDisabled && (
                            <Text style={styles.prefsBarNote}>
                                Off for these suggestions only. Your saved preferences are unchanged.
                            </Text>
                        )}

                        {!!currentUsageNotice && (
                            <View
                                style={[
                                    styles.usageRow,
                                    currentUsageNotice.level !== 'normal' && styles.usageRowWarning,
                                    (currentUsageNotice.level === 'critical' || currentUsageNotice.level === 'exhausted') && styles.usageRowCritical,
                                ]}
                            >
                                <Ionicons
                                    name={currentUsageNotice.level === 'normal' ? 'sparkles-outline' : 'time-outline'}
                                    size={14}
                                    color={currentUsageNotice.level === 'exhausted' ? '#A44133' : inkMuted}
                                    accessible={false}
                                />
                                <Text style={[
                                    styles.usageText,
                                    (currentUsageNotice.level === 'critical' || currentUsageNotice.level === 'exhausted')
                                        && styles.usageTextExhausted,
                                ]}
                                    accessibilityRole={
                                        currentUsageNotice.level === 'critical' || currentUsageNotice.level === 'exhausted'
                                            ? 'alert'
                                            : 'text'
                                    }
                                    accessibilityLiveRegion={
                                        currentUsageNotice.level === 'critical' || currentUsageNotice.level === 'exhausted'
                                            ? 'assertive'
                                            : 'polite'
                                    }
                                >
                                    {currentUsageNotice.title} · {currentUsageNotice.reset}
                                </Text>
                                {!isPro && currentUsageNotice.level !== 'normal' && (
                                    <GlassPressable
                                        onPress={() => openPaywall('quota')}
                                        hitSlop={8}
                                        accessibilityLabel="Get Fridgie Pro for more weekly suggestions"
                                    >
                                        <Text style={styles.usageUpgrade}>Get more with Pro</Text>
                                    </GlassPressable>
                                )}
                            </View>
                        )}
                    </View>

                    <ScrollView
                        ref={scrollRef}
                        style={styles.transcript}
                        contentContainerStyle={styles.transcriptContent}
                        keyboardShouldPersistTaps="handled"
                        // 'interactive' is iOS dragging the keyboard itself down,
                        // which needs the scroll view to extend under it. The
                        // avoider lifts this sheet clear of the keyboard instead,
                        // so nothing here ever overlaps it and the gesture had
                        // nothing to grab. 'on-drag' dismisses on the same swipe.
                        keyboardDismissMode="on-drag"
                        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: !reduceMotion })}
                    >
                        {transcript.length === 0 && !isSuggesting && (
                            <View style={styles.welcome}>
                                <View style={styles.welcomeIcon}><Ionicons name="sparkles-outline" size={28} color={primary} /></View>
                                <Text style={styles.welcomeTitle}>What sounds good?</Text>
                                <Text style={styles.welcomeText}>
                                    Tell me what you&apos;re after tonight, tap a few hints, or just
                                    hit send and I&apos;ll pick three.
                                </Text>
                            </View>
                        )}

                        {transcript.map(bubble => {
                            if (bubble.kind === 'suggestions') {
                                return (
                                    <View key={bubble.id} style={styles.suggestionGroup}>
                                        {bubble.recipes.map(recipe => {
                                            const isSelected = !!selectedSuggestions[recipe.id];
                                            return (
                                                <GlassPressable
                                                    key={recipe.id}
                                                    style={[styles.suggestionCard, isSelected && styles.suggestionCardSelected]}
                                                    onPress={() => toggleSuggestion(recipe.id)}
                                                    accessibilityRole="checkbox"
                                                    accessibilityState={{ checked: isSelected }}
                                                    accessibilityLabel={`Select ${recipe.name}`}
                                                >
                                                    <View style={[styles.checkbox, isSelected && styles.checkboxOn]}>
                                                        {isSelected && <Ionicons name="checkmark" size={15} color="#fff" />}
                                                    </View>
                                                    <View style={{ flex: 1 }}>
                                                        <Text style={styles.suggestionName}>{recipe.name}</Text>
                                                        <Text style={styles.suggestionDescription}>{recipe.description}</Text>
                                                    </View>
                                                </GlassPressable>
                                            );
                                        })}

                                        {bubble.id === lastSuggestionId && !isSuggesting && (
                                            <GlassPressable
                                                style={styles.rerollButton}
                                                onPress={reroll}
                                                disabled={isLoadingPrefs || isInteractionBusy}
                                                accessibilityState={{ disabled: isLoadingPrefs || isInteractionBusy }}
                                            >
                                                <Ionicons name="refresh" size={16} color={primary} />
                                                <Text style={styles.rerollText}>Show 3 different options</Text>
                                            </GlassPressable>
                                        )}
                                    </View>
                                );
                            }
                            const mine = bubble.role === 'user';
                            return (
                                <View
                                    key={bubble.id}
                                    style={[styles.bubble, mine ? styles.userBubble : styles.assistantBubble]}
                                >
                                    <Text style={[styles.bubbleText, mine && styles.userBubbleText]}>{bubble.text}</Text>
                                </View>
                            );
                        })}

                        {isSuggesting && (
                            <View style={[styles.bubble, styles.assistantBubble, styles.loadingBubble]}>
                                <ActivityIndicator size="small" color={primary} />
                                <Text style={styles.loadingText}>{loadingMessage}</Text>
                            </View>
                        )}
                    </ScrollView>

                    {/* Hints, not preferences. Available on the very first
                        generation and cleared after each one, because they
                        describe tonight rather than the person. */}
                    <View style={styles.hintsArea}>
                        {leftoversIngredients.length ? (
                            <View style={styles.leftoversActive}>
                                <View style={styles.leftoversActiveIcon}>
                                    <Ionicons name="checkmark" size={16} color="#FFF" />
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.leftoversActiveTitle}>Cooking from {leftoversIngredients.length} confirmed ingredients</Text>
                                    <Text style={styles.leftoversActiveText} numberOfLines={1}>{leftoversIngredients.join(', ')}</Text>
                                </View>
                                <GlassPressable
                                    onPress={() => setLeftoversIngredients([])}
                                    style={styles.leftoversClear}
                                    accessibilityLabel="Stop using confirmed leftovers"
                                >
                                    <Text style={styles.leftoversClearText}>Clear</Text>
                                </GlassPressable>
                            </View>
                        ) : (
                            <GlassPressable
                                style={styles.leftoversEntry}
                                onPress={() => { void openLeftovers(); }}
                                disabled={isLoadingPro || isLoadingPrefs || isInteractionBusy}
                                accessibilityLabel="Open Leftovers Mode, a Fridgie Pro feature"
                            >
                                <View style={styles.leftoversEntryIcon}>
                                    <Ionicons name="camera-outline" size={19} color={primary} />
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.leftoversEntryTitle}>Scan your fridge or pantry</Text>
                                    <Text style={styles.leftoversEntryText}>Turn a few photos into editable ingredients</Text>
                                </View>
                                {isLoadingPro ? <ActivityIndicator size="small" color={primary} /> : (
                                    <View style={styles.proBadge}><Text style={styles.proBadgeText}>PRO</Text></View>
                                )}
                                <Ionicons name="chevron-forward" size={17} color={inkMuted} />
                            </GlassPressable>
                        )}
                        {HINT_GROUPS.map(group => (
                            <View key={group.label} style={styles.hintRow}>
                                <Text style={styles.hintRowLabel}>{group.label}</Text>
                                <ScrollView
                                    horizontal
                                    showsHorizontalScrollIndicator={false}
                                    keyboardShouldPersistTaps="handled"
                                    contentContainerStyle={styles.hintRowContent}
                                >
                                    {group.tags.map(tag => {
                                        const on = selectedHints.includes(tag);
                                        return (
                                            <GlassPressable
                                                key={tag}
                                                style={[styles.hintChip, on && styles.hintChipOn]}
                                                onPress={() => toggleHint(tag)}
                                                accessibilityState={{ selected: on }}
                                            >
                                                <Text style={[styles.hintChipText, on && styles.hintChipTextOn]}>{tag}</Text>
                                            </GlassPressable>
                                        );
                                    })}
                                </ScrollView>
                            </View>
                        ))}
                    </View>

                    <GlassSurface style={styles.composer} intensity={65}>
                        <TextInput
                            style={styles.composerInput}
                            placeholder={transcript.length ? 'Ask for something different...' : 'Anything specific tonight?'}
                            placeholderTextColor={inkMuted}
                            accessibilityLabel="Describe the meals you would like"
                            value={input}
                            onChangeText={setInput}
                            multiline
                        />
                        <GlassPressable
                            style={[styles.sendButton, (isInteractionBusy || isLoadingPrefs) && styles.sendButtonDisabled]}
                            onPress={generate}
                            accessibilityLabel="Generate meal suggestions"
                            accessibilityState={{ busy: isInteractionBusy, disabled: isInteractionBusy || isLoadingPrefs }}
                            disabled={isInteractionBusy || isLoadingPrefs}
                        >
                            {isInteractionBusy
                                ? <ActivityIndicator size="small" color="#fff" />
                                : <Ionicons name={transcript.length ? 'arrow-up' : 'sparkles'} size={20} color="#fff" />}
                        </GlassPressable>
                    </GlassSurface>

                    {selectedCount > 0 && (
                        <GlassPressable
                            style={[styles.addButton, isInteractionBusy && styles.sendButtonDisabled]}
                            onPress={handleAddSelectedMeals}
                            disabled={isInteractionBusy}
                            accessibilityState={{ busy: isAddingSelected, disabled: isInteractionBusy }}
                        >
                            <Text style={styles.addButtonText}>
                                {isAddingSelected
                                    ? 'Adding selected meals…'
                                    : `Add ${selectedCount} meal${selectedCount === 1 ? '' : 's'} to the plan`}
                            </Text>
                        </GlassPressable>
                    )}
                    </View>
                </KeyboardAvoidingView>
                <LeftoversModeModal
                    visible={isLeftoversVisible}
                    onClose={() => setIsLeftoversVisible(false)}
                    onConfirm={useConfirmedLeftovers}
                    onRequirePro={() => {
                        const session = suggestionSession.current;
                        void handleLeftoversProRequired(session);
                    }}
                    scanUsage={status?.leftoversScanUsage}
                    onScanUsageChanged={() => { void refreshPro(); }}
                    onRefreshAccountStatus={refreshPro}
                />
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    modalRoot: { flex: 1 },
    overlay: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { flex: 1, backgroundColor: 'rgba(15,37,28,0.32)' },
    sheet: { backgroundColor: '#F5F5EF', borderTopLeftRadius: 34, borderTopRightRadius: 34, maxHeight: '94%', flexShrink: 1, overflow: 'hidden' },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 15, borderRadius: 0, borderWidth: 0 },
    headerTitle: { fontSize: 19, fontWeight: '700', letterSpacing: -0.5, color: ink },
    closeButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#E5EDE3', alignItems: 'center', justifyContent: 'center' },
    prefsBar: { paddingHorizontal: 22, paddingTop: 15, paddingBottom: 12, backgroundColor: '#EBF0E7' },
    prefsBarHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    prefsBarLabel: { fontSize: 9, fontWeight: '700', color: inkMuted, textTransform: 'uppercase', letterSpacing: 1.3 },
    prefsBarEdit: { fontSize: 12, color: primary, fontWeight: '600' },
    prefsBarNote: { fontSize: 11, lineHeight: 17, color: inkMuted, marginTop: 5 },
    usageRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 7 },
    usageRowWarning: { backgroundColor: '#F6ECD4', borderRadius: 12, paddingHorizontal: 9, paddingVertical: 7 },
    usageRowCritical: { backgroundColor: '#F4DDD0' },
    usageText: { flex: 1, fontSize: 10, lineHeight: 15, color: inkMuted },
    usageTextExhausted: { color: '#A44133', fontWeight: '600' },
    usageUpgrade: { color: primary, fontSize: 11, fontWeight: '800' },
    prefsEmpty: { fontSize: 13, color: inkMuted, marginTop: 4 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 7 },
    prefChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: primary, borderRadius: 17, paddingVertical: 8, paddingHorizontal: 12, marginRight: 6, marginBottom: 6, maxWidth: '100%', borderWidth: 1, borderColor: primary },
    prefChipOff: { backgroundColor: '#F5F5EF', borderColor: '#DCE3D8' },
    prefChipText: { color: '#FFF', fontSize: 12, fontWeight: '600', flexShrink: 1 },
    prefChipTextOff: { color: inkMuted, textDecorationLine: 'line-through' },
    transcript: { flexGrow: 0, flexShrink: 1 },
    transcriptContent: { padding: 20, paddingBottom: 10 },
    welcome: { paddingVertical: 12, alignItems: 'center' },
    welcomeIcon: { width: 64, height: 64, borderRadius: 23, backgroundColor: '#E8D9C7', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
    welcomeTitle: { fontSize: 26, fontWeight: '700', letterSpacing: -0.9, color: ink, marginBottom: 9 },
    welcomeText: { fontSize: 14, lineHeight: 22, color: inkMuted, textAlign: 'center', maxWidth: 290 },
    bubble: { borderRadius: 22, paddingVertical: 13, paddingHorizontal: 17, marginBottom: 12, maxWidth: '90%' },
    assistantBubble: { backgroundColor: '#E8EEE3', alignSelf: 'flex-start', borderBottomLeftRadius: 6 },
    userBubble: { backgroundColor: primary, alignSelf: 'flex-end', borderBottomRightRadius: 6 },
    bubbleText: { fontSize: 15, color: ink, lineHeight: 23 },
    userBubbleText: { color: '#FFF' },
    loadingBubble: { flexDirection: 'row', alignItems: 'center' },
    loadingText: { marginLeft: 10, fontSize: 14, color: inkMuted, flexShrink: 1 },
    suggestionGroup: { marginBottom: 12 },
    suggestionCard: { flexDirection: 'row', alignItems: 'flex-start', padding: 18, borderWidth: 1, borderColor: '#FFF', borderRadius: 25, marginBottom: 10, backgroundColor: 'rgba(255,255,255,0.9)' },
    suggestionCardSelected: { borderColor: primary, backgroundColor: '#DCEDE2' },
    rerollButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, alignSelf: 'flex-start', paddingVertical: 11, paddingHorizontal: 15, borderRadius: 21, backgroundColor: '#E6EDE1', marginTop: 3 },
    rerollText: { color: primary, fontSize: 12, fontWeight: '600' },
    checkbox: { width: 24, height: 24, borderWidth: 1.5, borderColor: '#C5D1C2', borderRadius: 12, marginRight: 12, marginTop: 1, alignItems: 'center', justifyContent: 'center' },
    checkboxOn: { backgroundColor: primary, borderColor: primary },
    suggestionName: { fontSize: 17, fontWeight: '700', letterSpacing: -0.5, color: ink },
    suggestionDescription: { fontSize: 13, color: inkMuted, marginTop: 6, lineHeight: 20 },
    hintsArea: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DCE3D8', paddingTop: 11 },
    leftoversEntry: { marginHorizontal: 16, marginBottom: 11, minHeight: 58, paddingHorizontal: 12, borderRadius: 21, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E1E7DE', flexDirection: 'row', alignItems: 'center', gap: 10 },
    leftoversEntryIcon: { width: 36, height: 36, borderRadius: 14, backgroundColor: '#DCEDE2', alignItems: 'center', justifyContent: 'center' },
    leftoversEntryTitle: { fontSize: 13, fontWeight: '700', color: ink },
    leftoversEntryText: { fontSize: 10, lineHeight: 15, color: inkMuted, marginTop: 1 },
    proBadge: { backgroundColor: '#E8D9C7', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 9 },
    proBadgeText: { color: '#795B25', fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
    leftoversActive: { marginHorizontal: 16, marginBottom: 11, minHeight: 58, paddingHorizontal: 12, borderRadius: 21, backgroundColor: '#DCEDE2', flexDirection: 'row', alignItems: 'center', gap: 10 },
    leftoversActiveIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: primary, alignItems: 'center', justifyContent: 'center' },
    leftoversActiveTitle: { fontSize: 12, fontWeight: '700', color: ink },
    leftoversActiveText: { fontSize: 10, color: inkMuted, marginTop: 2 },
    leftoversClear: { paddingHorizontal: 8, paddingVertical: 9 },
    leftoversClearText: { color: primary, fontSize: 11, fontWeight: '700' },
    hintRow: { marginBottom: 9 },
    hintRowLabel: { fontSize: 9, fontWeight: '700', color: inkMuted, textTransform: 'uppercase', letterSpacing: 1.3, paddingHorizontal: 22, marginBottom: 6 },
    hintRowContent: { paddingHorizontal: 20 },
    hintChip: { backgroundColor: '#FFF', borderRadius: 18, paddingVertical: 8, paddingHorizontal: 13, marginRight: 6, borderWidth: 1, borderColor: '#FFF' },
    hintChipOn: { backgroundColor: '#DCEDE2', borderColor: primary },
    hintChipText: { fontSize: 12, color: inkMuted },
    hintChipTextOn: { color: primary, fontWeight: '700' },
    composer: { flexDirection: 'row', alignItems: 'flex-end', marginHorizontal: 16, marginTop: 3, padding: 7, borderRadius: 28 },
    composerInput: { flex: 1, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 12, fontSize: 14, color: ink, maxHeight: 100 },
    sendButton: { width: 43, height: 43, borderRadius: 22, backgroundColor: primary, alignItems: 'center', justifyContent: 'center', marginLeft: 7 },
    sendButtonDisabled: { backgroundColor: '#BDCFBD' },
    addButton: { backgroundColor: primary, marginHorizontal: 16, marginTop: 11, paddingVertical: 16, borderRadius: 25, alignItems: 'center' },
    addButtonText: { color: '#FFF', fontSize: 15, fontWeight: '700' },
});
