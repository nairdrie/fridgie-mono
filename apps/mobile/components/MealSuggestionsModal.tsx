import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
    TouchableOpacity,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import uuid from 'react-native-uuid';

import { Item, Meal, MealPreferences, Recipe, SuggestionTurn } from '@/types/types';
import { primary } from '@/utils/styles';
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
    const [prefs, setPrefs] = useState<MealPreferences | null>(null);
    const [isLoadingPrefs, setIsLoadingPrefs] = useState(true);

    const [transcript, setTranscript] = useState<Bubble[]>([]);
    const [input, setInput] = useState('');
    const [selectedHints, setSelectedHints] = useState<string[]>([]);

    // Preferences the user has switched off FOR THIS SHEET ONLY. Nothing here is
    // ever written back — closing the sheet restores the saved profile.
    const [disabledNeeds, setDisabledNeeds] = useState<string[]>([]);
    const [dislikesOff, setDislikesOff] = useState(false);

    const [isSuggesting, setIsSuggesting] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState(LOADING_MESSAGES[0]);
    const [selectedSuggestions, setSelectedSuggestions] = useState<Record<string, boolean>>({});
    // Titles already shown this session, so a follow-up doesn't repeat them.
    const [vetoedMeals, setVetoedMeals] = useState<string[]>([]);
    // The terms of the last ask. Sending clears the composer and the chips, so
    // without this a re-roll would have nothing left to ask again on.
    const [lastAsk, setLastAsk] = useState<{ query: string; hints: string[] }>({ query: '', hints: [] });

    const scrollRef = useRef<ScrollView | null>(null);
    const router = useRouter();

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
        if (!isVisible) return;

        // Every open starts a fresh conversation, and a fresh set of temporary
        // overrides — a preference switched off last night must not still be off
        // tonight.
        setTranscript([]);
        setInput('');
        setSelectedHints([]);
        setDisabledNeeds([]);
        setDislikesOff(false);
        setSelectedSuggestions({});
        setVetoedMeals([]);
        setLastAsk({ query: '', hints: [] });
        setIsSuggesting(false);

        const fetchPreferences = async () => {
            setIsLoadingPrefs(true);
            try {
                const loaded = await getMealPreferences();
                setPrefs(loaded);
            } catch (error) {
                if (error instanceof ApiError && error.status === 404) {
                    // First run: send them to set the everyday baseline, and come
                    // back here afterwards.
                    onClose();
                    await AsyncStorage.setItem('pendingAction', 'suggest-meals');
                    router.navigate('/meal-preferences');
                    return;
                }
                console.error('Failed to fetch meal preferences:', error);
                onClose();
                Alert.alert('Error', 'Could not load your meal preferences. Please try again.');
                return;
            } finally {
                setIsLoadingPrefs(false);
            }
        };

        fetchPreferences();
    }, [isVisible]);

    const push = (bubble: Bubble) => setTranscript(prev => [...prev, bubble]);

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
        extraTurns?: SuggestionTurn[];
    }) => {
        push({ id: uuid.v4() as string, role: 'user', kind: 'text', text: ask.spoken });

        // Read before the push above has committed, which is what keeps the turn
        // being made now from also arriving as history.
        const conversation = [...conversationForApi(), ...(ask.extraTurns ?? [])];

        // Deliberately NOT clearing selections: earlier sets stay on screen and
        // stay tickable, so asking for more must not silently drop the dish they
        // already picked.
        setIsSuggesting(true);

        try {
            const recipes = await getMealSuggestions({
                vetoedTitles: vetoedMeals,
                // Always sent, so what the chips show is exactly what applies.
                overrides: { dietaryNeeds: activeNeeds, dislikedIngredients: activeDislikes },
                hints: ask.hints,
                query: ask.query,
                conversation,
            });

            const withIds = recipes.map(r => ({ ...r, id: uuid.v4() as string }));
            setVetoedMeals(prev => [...prev, ...withIds.map(r => r.name)]);
            push({ id: uuid.v4() as string, role: 'assistant', kind: 'suggestions', recipes: withIds });
        } catch (error) {
            console.error('Meal suggestion failed:', error);
            push({
                id: uuid.v4() as string,
                role: 'assistant',
                kind: 'text',
                text: "That didn't work. Try again, or change what you're asking for.",
            });
        } finally {
            setIsSuggesting(false);
        }
    };

    const generate = async () => {
        if (isSuggesting) return;
        // The overrides sent below are built from `prefs`. Firing before it has
        // loaded would send an empty dietaryNeeds — i.e. quietly drop the
        // constraints — and hand a vegan a beef stew.
        if (isLoadingPrefs) return;

        const query = input.trim();
        const hints = selectedHints;

        setLastAsk({ query, hints });
        setInput('');
        setSelectedHints([]);

        // Echo what was asked for, so the transcript reads as a conversation even
        // when they just tapped the button with nothing typed.
        const spoken = [query, hints.length ? hints.join(', ') : ''].filter(Boolean).join(' · ');
        await requestSuggestions({ spoken: spoken || 'Suggest 3 dinners', query, hints });
    };

    /**
     * Three more, on the same brief. The query and hints of the last ask go back
     * unchanged, so the mood, cuisine and typed request still apply; what makes
     * the next three different is `vetoedMeals`, which by now holds every title
     * shown this session and reaches the model as "do not repeat or closely
     * echo". The dietary chips are re-read at send time, as for any other ask.
     */
    const reroll = async () => {
        if (isSuggesting || isLoadingPrefs) return;
        await requestSuggestions({
            spoken: REROLL_ASK,
            query: lastAsk.query,
            hints: lastAsk.hints,
            extraTurns: [{ role: 'user', text: REROLL_ASK }],
        });
    };

    const toggleHint = (tag: string) =>
        setSelectedHints(prev => (prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]));

    const toggleNeed = (need: string) =>
        setDisabledNeeds(prev => (prev.includes(need) ? prev.filter(n => n !== need) : [...prev, need]));

    const toggleSuggestion = (recipeId: string) =>
        setSelectedSuggestions(prev => ({ ...prev, [recipeId]: !prev[recipeId] }));

    const handleEditPreferences = async () => {
        onClose();
        await AsyncStorage.setItem('pendingAction', 'suggest-meals');
        router.navigate('/meal-preferences');
    };

    const allSuggested = useMemo(
        () => transcript.flatMap(b => (b.kind === 'suggestions' ? b.recipes : [])),
        [transcript],
    );
    const selectedCount = allSuggested.filter(r => selectedSuggestions[r.id]).length;

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
        const chosen = allSuggested.filter(r => selectedSuggestions[r.id]);
        if (chosen.length === 0) {
            onClose();
            return;
        }

        try {
            const saved = await Promise.all(chosen.map(recipe => saveRecipe(recipe)));

            const newMeals: Meal[] = [];
            const newItems: Item[] = [];

            for (const recipe of saved) {
                const newMeal: Meal = {
                    id: uuid.v4() as string,
                    listId,
                    name: recipe.name,
                    recipeId: recipe.id,
                };
                newMeals.push(newMeal);

                for (const ingredient of recipe.ingredients) {
                    newItems.push({
                        id: uuid.v4() as string,
                        text: ingredient.name.trim(),
                        quantity: ingredient.quantity.trim(),
                        checked: false,
                        listOrder: 'NEEDS-RANK', // Parent assigns the real rank.
                        isSection: false,
                        mealId: newMeal.id,
                    });
                }
            }

            onAddSelectedMeals(newMeals, newItems);
        } catch (error) {
            console.error('Failed to add selected meals:', error);
            Alert.alert('Error', 'Could not add the selected meals. Please try again.');
        } finally {
            onClose();
        }
    };

    return (
        <Modal animationType="slide" transparent visible={isVisible} onRequestClose={onClose}>
            {/* Full-screen avoider around a bottom sheet with a composer in it —
                see AddEditRecipeModal for why this has to wrap the sheet rather
                than be the sheet. */}
            <KeyboardAvoidingView
                style={styles.overlay}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <Pressable style={styles.backdrop} onPress={onClose} />
                <View style={[styles.sheet, { paddingBottom: bottomPad }]}>
                    <View style={styles.header}>
                        <View style={{ width: 28 }} />
                        <Text style={styles.headerTitle}>Suggest Meals</Text>
                        <TouchableOpacity onPress={onClose} hitSlop={10}>
                            <Ionicons name="close-circle" size={28} color="#bbb" />
                        </TouchableOpacity>
                    </View>

                    {/* What will actually be applied, and the one-tap way to drop
                        it for tonight only. */}
                    <View style={styles.prefsBar}>
                        <View style={styles.prefsBarHeader}>
                            <Text style={styles.prefsBarLabel}>
                                {hasSavedPrefs ? 'Applying' : 'No saved preferences'}
                            </Text>
                            <TouchableOpacity onPress={handleEditPreferences} hitSlop={8}>
                                <Text style={styles.prefsBarEdit}>Edit saved</Text>
                            </TouchableOpacity>
                        </View>

                        {isLoadingPrefs ? (
                            <ActivityIndicator size="small" style={{ alignSelf: 'flex-start', marginTop: 4 }} />
                        ) : (
                            <View style={styles.chipRow}>
                                {(prefs?.dietaryNeeds ?? []).map(need => {
                                    const off = disabledNeeds.includes(need);
                                    return (
                                        <TouchableOpacity
                                            key={need}
                                            style={[styles.prefChip, off && styles.prefChipOff]}
                                            onPress={() => toggleNeed(need)}
                                        >
                                            <Text style={[styles.prefChipText, off && styles.prefChipTextOff]}>{need}</Text>
                                            <Ionicons
                                                name={off ? 'add-circle-outline' : 'close-circle'}
                                                size={15}
                                                color={off ? '#aaa' : '#fff'}
                                                style={{ marginLeft: 5 }}
                                            />
                                        </TouchableOpacity>
                                    );
                                })}
                                {!!prefs?.dislikedIngredients && (
                                    <TouchableOpacity
                                        style={[styles.prefChip, dislikesOff && styles.prefChipOff]}
                                        onPress={() => setDislikesOff(v => !v)}
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
                                    </TouchableOpacity>
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
                        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
                    >
                        {transcript.length === 0 && !isSuggesting && (
                            <View style={[styles.bubble, styles.assistantBubble]}>
                                <Text style={styles.bubbleText}>
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
                                                <TouchableOpacity
                                                    key={recipe.id}
                                                    style={[styles.suggestionCard, isSelected && styles.suggestionCardSelected]}
                                                    onPress={() => toggleSuggestion(recipe.id)}
                                                >
                                                    <View style={[styles.checkbox, isSelected && styles.checkboxOn]}>
                                                        {isSelected && <Ionicons name="checkmark" size={15} color="#fff" />}
                                                    </View>
                                                    <View style={{ flex: 1 }}>
                                                        <Text style={styles.suggestionName}>{recipe.name}</Text>
                                                        <Text style={styles.suggestionDescription}>{recipe.description}</Text>
                                                    </View>
                                                </TouchableOpacity>
                                            );
                                        })}

                                        {bubble.id === lastSuggestionId && !isSuggesting && (
                                            <TouchableOpacity
                                                style={styles.rerollButton}
                                                onPress={reroll}
                                                disabled={isLoadingPrefs}
                                            >
                                                <Ionicons name="refresh" size={16} color={primary} />
                                                <Text style={styles.rerollText}>Show 3 different options</Text>
                                            </TouchableOpacity>
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
                                            <TouchableOpacity
                                                key={tag}
                                                style={[styles.hintChip, on && styles.hintChipOn]}
                                                onPress={() => toggleHint(tag)}
                                            >
                                                <Text style={[styles.hintChipText, on && styles.hintChipTextOn]}>{tag}</Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </ScrollView>
                            </View>
                        ))}
                    </View>

                    <View style={styles.composer}>
                        <TextInput
                            style={styles.composerInput}
                            placeholder={transcript.length ? 'Ask for something different...' : 'Anything specific tonight?'}
                            placeholderTextColor="#999"
                            value={input}
                            onChangeText={setInput}
                            multiline
                        />
                        <TouchableOpacity
                            style={[styles.sendButton, (isSuggesting || isLoadingPrefs) && styles.sendButtonDisabled]}
                            onPress={generate}
                            disabled={isSuggesting || isLoadingPrefs}
                        >
                            <Ionicons name={transcript.length ? 'arrow-up' : 'sparkles'} size={20} color="#fff" />
                        </TouchableOpacity>
                    </View>

                    {selectedCount > 0 && (
                        <TouchableOpacity style={styles.addButton} onPress={handleAddSelectedMeals}>
                            <Text style={styles.addButtonText}>
                                Add {selectedCount} meal{selectedCount === 1 ? '' : 's'} to the plan
                            </Text>
                        </TouchableOpacity>
                    )}
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
    sheet: {
        backgroundColor: '#fff',
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        // paddingBottom is set inline — it depends on the home indicator and on
        // whether the keyboard is currently covering it.
        maxHeight: '92%',
        flexShrink: 1,
    },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#EFEFEF',
    },
    headerTitle: { fontSize: 17, fontWeight: '700', color: '#222' },

    prefsBar: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8, backgroundColor: '#FAFAFA' },
    prefsBarHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    prefsBarLabel: { fontSize: 11, fontWeight: '700', color: '#999', textTransform: 'uppercase', letterSpacing: 0.5 },
    prefsBarEdit: { fontSize: 13, color: primary, fontWeight: '600' },
    prefsBarNote: { fontSize: 11, color: '#999', marginTop: 6, fontStyle: 'italic' },
    prefsEmpty: { fontSize: 14, color: '#999', marginTop: 4 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },

    prefChip: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: primary,
        borderRadius: 16,
        paddingVertical: 6,
        paddingHorizontal: 12,
        marginRight: 6,
        marginBottom: 6,
        maxWidth: '100%',
        borderWidth: 1,
        borderColor: primary,
    },
    prefChipOff: { backgroundColor: '#F0F0F0', borderColor: '#E0E0E0' },
    prefChipText: { color: '#fff', fontSize: 13, fontWeight: '600', flexShrink: 1 },
    prefChipTextOff: { color: '#aaa', textDecorationLine: 'line-through' },

    transcript: { flexGrow: 0, flexShrink: 1 },
    transcriptContent: { padding: 16, paddingBottom: 8 },

    bubble: { borderRadius: 16, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 10, maxWidth: '85%' },
    assistantBubble: { backgroundColor: '#F2F2F4', alignSelf: 'flex-start', borderBottomLeftRadius: 4 },
    userBubble: { backgroundColor: primary, alignSelf: 'flex-end', borderBottomRightRadius: 4 },
    bubbleText: { fontSize: 15, color: '#222', lineHeight: 21 },
    userBubbleText: { color: '#fff' },
    loadingBubble: { flexDirection: 'row', alignItems: 'center' },
    loadingText: { marginLeft: 10, fontSize: 15, color: '#666', fontStyle: 'italic' },

    suggestionGroup: { marginBottom: 10 },
    suggestionCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        padding: 14,
        borderWidth: 1,
        borderColor: '#E4E4E7',
        borderRadius: 14,
        marginBottom: 8,
        backgroundColor: '#fff',
    },
    suggestionCardSelected: { borderColor: primary, backgroundColor: '#F4FAF8' },
    rerollButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        alignSelf: 'flex-start',
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: '#E4E4E7',
        backgroundColor: '#FAFAFA',
        marginTop: 2,
    },
    rerollText: { color: primary, fontSize: 14, fontWeight: '600' },
    checkbox: {
        width: 22,
        height: 22,
        borderWidth: 1.5,
        borderColor: '#CCC',
        borderRadius: 6,
        marginRight: 12,
        marginTop: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    checkboxOn: { backgroundColor: primary, borderColor: primary },
    suggestionName: { fontSize: 16, fontWeight: '600', color: '#1A1A1A' },
    suggestionDescription: { fontSize: 14, color: '#666', marginTop: 3, lineHeight: 19 },

    hintsArea: { borderTopWidth: 1, borderTopColor: '#EFEFEF', paddingTop: 8 },
    hintRow: { marginBottom: 6 },
    hintRowLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: '#AAA',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        paddingHorizontal: 16,
        marginBottom: 4,
    },
    hintRowContent: { paddingHorizontal: 16 },
    hintChip: {
        backgroundColor: '#F2F2F4',
        borderRadius: 15,
        paddingVertical: 6,
        paddingHorizontal: 13,
        marginRight: 6,
        borderWidth: 1,
        borderColor: '#EAEAEC',
    },
    hintChipOn: { backgroundColor: '#E4F1ED', borderColor: primary },
    hintChipText: { fontSize: 13, color: '#555' },
    hintChipTextOn: { color: primary, fontWeight: '700' },

    composer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: 16,
        paddingTop: 10,
    },
    composerInput: {
        flex: 1,
        borderWidth: 1,
        borderColor: '#E4E4E7',
        borderRadius: 20,
        paddingHorizontal: 14,
        paddingTop: 10,
        paddingBottom: 10,
        fontSize: 15,
        color: '#222',
        maxHeight: 100,
        backgroundColor: '#FAFAFA',
    },
    sendButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: primary,
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: 8,
    },
    sendButtonDisabled: { backgroundColor: '#CCC' },

    addButton: {
        backgroundColor: primary,
        marginHorizontal: 16,
        marginTop: 10,
        paddingVertical: 14,
        borderRadius: 12,
        alignItems: 'center',
    },
    addButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
