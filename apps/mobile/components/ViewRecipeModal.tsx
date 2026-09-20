// components/ViewRecipeModal.tsx
//
// SERVINGS, AND WHY THEY ARE ADJUSTABLE HERE
//
// A recipe feeds however many people its author cooked for, which is almost
// never how many people the reader cooks for. The shopping list already knew
// that — ingredients are multiplied by the household size on their way onto it
// — but the recipe itself still read as written, so the one screen where you
// decide whether to cook the thing showed amounts for somebody else's table.
//
// So the ingredient header carries a stepper. It multiplies what is ON SCREEN
// and nothing else: the stored recipe keeps the author's numbers, exactly as
// packages/shared/servings.ts insists. Moving it also records the new count as
// the household's usual, so the next recipe — imported, generated or written —
// opens at the number you actually cook for instead of asking again.
import { useAuth } from '@/context/AuthContext';
import { useCookbook } from '@/context/CookbookContext';
import { Recipe } from '@/types/types';
import { accentSoft, hairline, ink, inkFaint, inkMuted, primary, surface } from '@/utils/styles';
import { GlassPressable, GlassSurface, useGlassPreferences } from '@/components/ui/Glass';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getCardStyleFromTags } from '@/utils/recipeStyling';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { displayQuantity, nextUnitInCycle } from '@/utils/quantity';
import { scaleIngredients, servingsForScale, servingsRange, servingsScale } from '@/utils/servings';
import { getRecipe, hideRecipe, reportRecipe, saveRecipe, updateGroup, type ReportReason } from '../utils/api';
import AddToMealPlanModal from './AddToMealPlanModal'; // Import the new component
import CookMode from './CookMode';
import InstructionText from './InstructionText';

interface ViewRecipeModalProps {
    isVisible: boolean;
    onClose: () => void;
    onDismiss?: () => void;
    recipeId: string | null;
    onEdit: (recipe: Recipe) => void;
    /**
     * The screen's own list may need refetching now that the shelf has changed
     * — your profile's cookbook grid, say. Whether the recipe IS on the shelf
     * is deliberately NOT a prop: this modal is opened from Explore and from
     * other people's profiles, where the surrounding list is somebody else's
     * and answering from it said "In Cookbook" about a recipe the viewer had
     * never added. It asks `useCookbook` instead, which knows one shelf: yours.
     */
    onCookbookUpdate?: () => void;
    /**
     * The factor this recipe's ingredients were scaled by when they went on a
     * shopping list — `Meal.scale`, passed only when the recipe is being opened
     * from a planned meal.
     *
     * Everywhere else it is 1 and the stepper opens at the household's usual
     * count instead: in the cookbook, in Explore and on a profile there is no
     * shop to agree with, so there is nothing to contradict.
     */
    scale?: number;
    /**
     * Opened from the week's meal plan, where this recipe is already planned.
     * Only drops the Add to Plan action — the same three buttons that don't fit
     * side by side are also one button too many when one of them is a no-op.
     */
    inMealPlan?: boolean;
}

// TODO: ensure forking is working. (if I add to meal plan or cookbook, we dont need to. unless i want to edit)
// TODO: author, likes, comments

/**
 * The reasons offered, in the order they are shown.
 *
 * Deliberately short. A long menu makes people pick the first plausible entry
 * rather than the true one, and every extra option costs more in mis-filed
 * reports than it buys in precision. `other` is last so it is the fallback
 * rather than the easy default.
 */
const REPORT_OPTIONS: { reason: ReportReason; label: string }[] = [
    { reason: 'not-a-recipe', label: "This isn't a recipe" },
    { reason: 'spam', label: 'Spam or advertising' },
    { reason: 'offensive', label: 'Offensive or inappropriate' },
    { reason: 'stolen-content', label: "Someone else's content" },
    { reason: 'dangerous', label: 'Unsafe to cook' },
    { reason: 'other', label: 'Something else' },
];

/** How a source URL is described once it is on screen. */
const sourceLabel = (sourceUrl?: string): string => {
    if (!sourceUrl) return 'the web';
    try {
        const host = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, '');
        if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'TikTok';
        return host;
    } catch {
        return 'the web';
    }
};

export default function ViewRecipeModal({ isVisible, onClose, onDismiss, recipeId, onEdit, onCookbookUpdate, scale = 1, inMealPlan = false }: ViewRecipeModalProps) {
    const insets = useSafeAreaInsets();
    const { reduceMotion } = useGlassPreferences();
    const [recipe, setRecipe] = useState<Recipe | null>(null);
    const [isFetching, setIsFetching] = useState(false);
    const [isToggling, setIsToggling] = useState(false);
    const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);

    const { user, selectedGroup, refreshGroups } = useAuth();
    const { isInCookbook, addRecipe, removeRecipe } = useCookbook();
    /** On YOUR shelf — never "in the cookbook this was opened from". */
    const isCurrentlyInCookbook = isInCookbook(recipeId);

    /**
     * Null until the reader moves the stepper — which is what keeps this screen
     * from writing a number nobody chose. Everything below reads `servings`,
     * the chosen count or the one it opened at.
     */
    const [chosenServings, setChosenServings] = useState<number | null>(null);
    const [savedAsUsual, setSavedAsUsual] = useState(false);
    /** Per-row unit the reader has tapped to; index into the ingredient list. */
    const [unitChoices, setUnitChoices] = useState<Record<number, string>>({});
    /**
     * Saying what the recipe's own amounts feed, for one that never said.
     *
     * Nothing can be scaled without that number — not this screen and not the
     * shopping list — and most recipes in an existing cookbook predate the field
     * entirely, so without a way to fill it in from here the whole feature is
     * invisible on exactly the recipes someone already has.
     */
    const [draftYield, setDraftYield] = useState<number | null>(null);
    const [isSavingYield, setIsSavingYield] = useState(false);

    const written = recipe?.servings ?? null;
    /** What the shop was actually done for, when this came from a planned meal. */
    const shopped = useMemo(() => (scale === 1 ? null : servingsForScale(written, scale)), [written, scale]);
    const usual = selectedGroup?.householdSize ?? null;
    const opening = written ? (shopped ?? usual ?? written) : null;
    const servings = chosenServings ?? opening;
    const range = useMemo(() => servingsRange(written), [written]);

    /**
     * Untouched inside a meal plan this stays the EXACT factor the shopping was
     * done at, not one recomputed from the rounded label above it: the cook
     * needs the amounts that are in the cupboard, and a recipe for five halved
     * is not a recipe for three.
     */
    const factor = useMemo(() => {
        if (!written || !servings) return scale;
        if (chosenServings === null && shopped !== null) return scale;
        return servingsScale(written, servings);
    }, [written, servings, chosenServings, shopped, scale]);

    const ingredients = useMemo(
        () => scaleIngredients(recipe?.ingredients ?? [], factor),
        [recipe?.ingredients, factor],
    );

    /** "Serves 4" · "written for 4 · shopped for 2 · saved as your usual". */
    const scaleNote = useMemo(() => {
        const parts: string[] = [];
        if (written) parts.push(servings === written ? `Serves ${written}` : `Written for ${written}`);
        if (shopped && servings !== shopped) parts.push(`shopped for ${shopped}`);
        if (savedAsUsual) parts.push('saved as your usual');
        return parts.join(' · ');
    }, [written, servings, shopped, savedAsUsual]);

    // [NEW] State for the meal plan modal
    const [isMealPlanModalVisible, setIsMealPlanModalVisible] = useState(false);
    const [isCooking, setIsCooking] = useState(false);

    useEffect(() => {
        if (!isVisible) {
            setIsConfirmingRemove(false);
            setIsCooking(false);
        }

        if (!recipeId || !isVisible) {
            setRecipe(null);
            return;
        }

        const fetchRecipe = async () => {
            setIsFetching(true);
            setRecipe(null);
            // A different recipe means a different set of amounts: neither the
            // servings the last one was read at nor the units it was read in
            // belong to this one.
            setChosenServings(null);
            setSavedAsUsual(false);
            setUnitChoices({});
            setDraftYield(null);
            try {
                const fullRecipe = await getRecipe(recipeId);
                setRecipe(fullRecipe);
            } catch (error) {
                console.error("Failed to fetch recipe:", error);
                Alert.alert("Error", "Could not load the recipe.");
                onClose();
            } finally {
                setIsFetching(false);
            }
        };

        fetchRecipe();
    }, [recipeId, isVisible]);

    /**
     * Remembering the count, so the next recipe doesn't ask again.
     *
     * It writes the group's household size — the same setting the groups screen
     * edits — rather than a second private copy of the number. Two sources of
     * truth here would mean a recipe screen reading "cooking for 2" over a
     * shopping list quietly buying for four.
     *
     * Owner-gated because the API is (see api/group/[id].ts), debounced because
     * the control is a stepper, and silent on failure: the amounts on screen are
     * already right, and an alert about a preference nobody asked to save is
     * worse than quietly not saving it.
     */
    useEffect(() => {
        if (chosenServings === null || !selectedGroup) return;
        if (selectedGroup.owner !== user?.uid) return;
        if (chosenServings === usual) return;

        const timer = setTimeout(async () => {
            try {
                await updateGroup(selectedGroup.id, { householdSize: chosenServings });
                setSavedAsUsual(true);
                refreshGroups();
            } catch (error) {
                console.warn('Could not save the household size from the recipe view:', error);
            }
        }, 900);
        return () => clearTimeout(timer);
        // Fields of the group rather than the group itself: its identity churns
        // as presence arrives, and re-running this on every heartbeat would keep
        // restarting the debounce and never save anything.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chosenServings, selectedGroup?.id, selectedGroup?.owner, usual, user?.uid]);

    const stepServings = (delta: number) => {
        if (!servings) return;
        const next = Math.min(range.max, Math.max(range.min, servings + delta));
        if (next === servings) return;
        Haptics.selectionAsync().catch(() => {});
        setChosenServings(next);
    };

    /** Tap an amount to read it in another unit. See `conversionCycle`. */
    const cycleUnit = (index: number, cycle: string[], current: string | null) => {
        const next = nextUnitInCycle(cycle, current);
        if (!next) return;
        Haptics.selectionAsync().catch(() => {});
        setUnitChoices((prev) => ({ ...prev, [index]: next }));
    };

    const stepDraftYield = (delta: number) => {
        setDraftYield((prev) => Math.min(range.max, Math.max(range.min, (prev ?? 4) + delta)));
    };

    /**
     * Writes the yield onto the recipe itself — the one thing on this screen
     * that does change the stored document, because it is a fact about the
     * author's amounts rather than a preference of the reader's.
     *
     * Offered only on recipes the caller already owns. Saving someone else's
     * forks it (see POST /api/recipe), and quietly making a copy of a stranger's
     * recipe because you told it how many it feeds is not a trade anyone asked
     * for. The response is deliberately not adopted: it strips the derived
     * author fields, and patching locally keeps the byline on screen.
     */
    const confirmYield = async () => {
        if (!recipe || !draftYield) return;
        setIsSavingYield(true);
        try {
            await saveRecipe({ ...recipe, servings: draftYield });
            setRecipe((prev) => (prev ? { ...prev, servings: draftYield } : prev));
            // Deliberately does NOT become the chosen count. Two reasons: the
            // number just stated is the RECIPE's, and treating it as the
            // reader's would save it as the household's usual a second later;
            // and the stepper settling on that usual is the feature doing
            // exactly what it says — a recipe for six, shown for two.
            setDraftYield(null);
        } catch (error) {
            console.error('Failed to save recipe servings:', error);
            Alert.alert('Error', 'Could not save that.');
        } finally {
            setIsSavingYield(false);
        }
    };

    /** Whether the viewer is looking at somebody else's recipe. */
    const isSomeoneElses = !!recipe && !!recipe.authorUid && recipe.authorUid !== user?.uid;

    /**
     * Open the original.
     *
     * Explore shows recipes imported from TikToks and recipe blogs, and the
     * structured version on this screen is a reading of the original, not a
     * replacement for it. Anyone deciding whether to trust the quantities
     * should be one tap from the video they came out of.
     */
    const handleOpenSource = async () => {
        if (!recipe?.sourceUrl) return;
        const canOpen = await Linking.canOpenURL(recipe.sourceUrl).catch(() => false);
        if (!canOpen) {
            Alert.alert("Can't open that link", 'The original may have been taken down.');
            return;
        }
        Linking.openURL(recipe.sourceUrl).catch(() => {
            Alert.alert("Can't open that link", 'The original may have been taken down.');
        });
    };

    const submitReport = async (reason: ReportReason) => {
        if (!recipeId) return;
        try {
            await reportRecipe(recipeId, reason);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            // Deliberately does not say whether the recipe was taken down. The
            // threshold is not the reporter's business, and telling them "2 more
            // reports needed" is an invitation to go and find two more accounts.
            Alert.alert('Thanks for telling us', "We'll take a look. You won't see this recipe again.");
            onClose();
        } catch (error) {
            console.error('Report failed:', error);
            Alert.alert('Report failed', 'Please try again in a moment.');
        }
    };

    const handleReport = () => {
        Alert.alert(
            'Report this recipe',
            "Tell us what's wrong with it.",
            [
                ...REPORT_OPTIONS.map((option) => ({
                    text: option.label,
                    onPress: () => submitReport(option.reason),
                })),
                { text: 'Cancel', style: 'cancel' as const },
            ],
        );
    };

    const handleHide = async () => {
        if (!recipeId) return;
        try {
            await hideRecipe(recipeId);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onClose();
        } catch (error) {
            console.error('Hide failed:', error);
            Alert.alert("Couldn't hide that", 'Please try again in a moment.');
        }
    };

    /**
     * The two escape hatches, kept apart.
     *
     * "Not for me" is one tap and affects nobody else. Reporting is a claim
     * about the recipe that gets acted on, so it is worded as one and asks what
     * is wrong before it does anything. Collapsing them into a single control
     * would make the milder action carry the weight of the serious one.
     *
     * Only offered on other people's recipes: there is nothing to report about
     * your own, and hiding one you own would take it out of your own Explore
     * while leaving it in your cookbook, which reads as a bug.
     */
    const handleMorePress = () => {
        Alert.alert(
            recipe?.name ?? 'This recipe',
            undefined,
            [
                { text: 'Not interested', onPress: handleHide },
                { text: 'Report…', style: 'destructive', onPress: handleReport },
                { text: 'Cancel', style: 'cancel' },
            ],
        );
    };

    /**
     * Somebody else wrote this one. Editing it is allowed, but what actually
     * happens is a copy: the server forks a recipe saved by anyone other than
     * its author, and the copy stops tracking the original from that moment.
     * That is a big enough difference to say out loud before the editor opens
     * rather than after the save.
     */
    const handleEditPress = () => {
        if (!recipe) return;
        const isAuthor = !recipe.authorUid || recipe.authorUid === user?.uid;
        if (isAuthor) {
            onEdit(recipe);
            return;
        }
        const theirs = recipe.authorName ? `${recipe.authorName}'s version` : 'The original';
        Alert.alert(
            'Make your own copy?',
            `${theirs} stays exactly as it is. You'll be editing a copy of your own, no longer linked to it — so any changes they make later won't reach yours.`,
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Make a Copy', onPress: () => onEdit(recipe) },
            ]
        );
    };

    /**
     * Adds to or removes from the VIEWER's cookbook — which is the only shelf
     * this button has ever written to, even back when it read its label off
     * somebody else's. The optimistic update and its rollback live in the
     * context, so every other screen showing this recipe turns over with it.
     */
    const handleToggleCookbook = async () => {
        if (!recipe) return;
        setIsToggling(true);

        try {
            if (isCurrentlyInCookbook) {
                await removeRecipe(recipe.id);
            } else {
                await addRecipe(recipe.id);
            }
            onCookbookUpdate?.();
        } catch (error) {
            console.error("Failed to toggle cookbook status:", error);
            Alert.alert("Error", "Could not update your cookbook.");
        } finally {
            setIsToggling(false);
        }
    };

    const handleCookbookButtonPress = () => {
        if (isCurrentlyInCookbook) {
            if (isConfirmingRemove) {
                handleToggleCookbook();
                setIsConfirmingRemove(false);
            } else {
                setIsConfirmingRemove(true);
            }
        } else {
            handleToggleCookbook();
        }
    };

    const handleClose = () => {
        setIsConfirmingRemove(false);
        setIsCooking(false);
        onClose();
    };

    const canScale = !!written && !!servings;
    /** Matches the server's fork rule exactly: no author, or you are them. */
    const isAuthor = !!recipe && (!recipe.authorUid || recipe.authorUid === user?.uid);
    const canDeclareYield = !written && isAuthor;

    return (
        <>
            <Modal
                animationType={reduceMotion ? "none" : "slide"}
                transparent={true}
                visible={isVisible}
                onRequestClose={isCooking ? () => setIsCooking(false) : handleClose}
                onDismiss={onDismiss}
            >
                <Pressable style={styles.modalBackdrop} onPress={handleClose} />
                <View style={styles.modalContainer}>
                    <View style={styles.modalContent}>
                        <GlassSurface style={styles.header} intensity={70}>
                            {isSomeoneElses && (
                                <GlassPressable
                                    style={styles.moreButton}
                                    onPress={handleMorePress}
                                    accessibilityRole="button"
                                    accessibilityLabel="Hide or report this recipe"
                                >
                                    <Ionicons name="ellipsis-horizontal" size={20} color={ink} />
                                </GlassPressable>
                            )}
                            <GlassPressable style={styles.closeButton} onPress={handleClose} accessibilityRole="button" accessibilityLabel="Close recipe">
                                <Ionicons name="close" size={22} color={ink} />
                            </GlassPressable>
                        </GlassSurface>

                        {isFetching && (<View style={styles.loaderContainer}><ActivityIndicator size="large" color={primary} /></View>)}

                        {recipe && (
                            <>
                                <FlatList
                                    style={{ flex: 1 }}
                                    ListHeaderComponent={
                                        <>
                                            <View style={styles.heroImage}>
                                                {recipe.photoURL ? <Image source={{ uri: recipe.photoURL }} style={styles.recipeImage} /> : (
                                                    <View style={styles.recipeImagePlaceholder}>
                                                        <View style={styles.heroOrb} />
                                                        <Ionicons name={getCardStyleFromTags(recipe.tags).icon} size={100} color={primary} />
                                                    </View>
                                                )}
                                                <GlassSurface style={styles.heroCategory} intensity={70}>
                                                    <Ionicons name="restaurant-outline" size={13} color={ink} />
                                                    <Text style={styles.heroCategoryText}>{recipe.category || 'Something delicious'}</Text>
                                                </GlassSurface>
                                            </View>
                                            <View style={styles.bodyContainer}>
                                                <View style={styles.titleContainer}>
                                                    <Text style={styles.recipeTitle}>{recipe.name}</Text>
                                                    {/* Shown on everyone's recipes, not just your own. On
                                                        someone else's it makes a copy, and says so first. */}
                                                    <GlassPressable
                                                        style={styles.editButton}
                                                        onPress={handleEditPress}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={
                                                            recipe.authorUid && recipe.authorUid !== user?.uid
                                                                ? 'Edit your own copy of this recipe'
                                                                : 'Edit recipe'
                                                        }
                                                    >
                                                        <Ionicons name="pencil" size={20} color="#fff" />
                                                    </GlassPressable>
                                                </View>
                                                { recipe.authorName &&
                                                  <Text style={styles.recipeAuthor}>by <Text style={styles.recipeAuthorName}>{recipe.authorName}</Text></Text>
                                                }

                                                {/* Where it actually came from, which is not the same as who saved
                                                    it. Everything below the title is this app's reading of a video
                                                    or a page somebody else published, and the credit for that
                                                    belongs on the screen rather than in a database column. */}
                                                {!!recipe.sourceUrl && (
                                                    <GlassPressable
                                                        style={styles.sourceRow}
                                                        onPress={handleOpenSource}
                                                        accessibilityRole="link"
                                                        accessibilityLabel={`Open the original on ${sourceLabel(recipe.sourceUrl)}`}
                                                    >
                                                        <Ionicons name="link-outline" size={14} color={inkMuted} />
                                                        <Text style={styles.sourceText} numberOfLines={1}>
                                                            From {sourceLabel(recipe.sourceUrl)}
                                                            {recipe.sourceAuthor ? ` · ${recipe.sourceAuthor}` : ''}
                                                        </Text>
                                                        <Ionicons name="open-outline" size={13} color={primary} />
                                                    </GlassPressable>
                                                )}

                                                {!!recipe.description && (
                                                    <Text style={styles.recipeDescription}>{recipe.description}</Text>
                                                )}

                                                {!!recipe.tags?.length && (
                                                    <View style={styles.tagRow}>
                                                        {recipe.tags.slice(0, 4).map((tag) => (
                                                            <View key={tag} style={styles.tag}>
                                                                <Text style={styles.tagText}>{tag}</Text>
                                                            </View>
                                                        ))}
                                                    </View>
                                                )}

                                                <View style={styles.sectionHeader}>
                                                    <Text style={styles.sectionTitle}>Ingredients</Text>
                                                    {/* The stepper takes the count's place: how many people
                                                        these amounts feed is the useful number here, and how
                                                        many lines the list runs to is not. A recipe with no
                                                        stated yield has nothing to scale against, so it keeps
                                                        the count. */}
                                                    {canScale ? (
                                                        <View style={styles.servingsStepper}>
                                                            <GlassPressable
                                                                style={styles.servingsButton}
                                                                onPress={() => stepServings(-1)}
                                                                disabled={servings! <= range.min}
                                                                hitSlop={8}
                                                                accessibilityRole="button"
                                                                accessibilityLabel="Fewer servings"
                                                            >
                                                                <Ionicons name="remove" size={16} color={servings! <= range.min ? inkFaint : primary} />
                                                            </GlassPressable>
                                                            <Text style={styles.servingsValue} accessibilityLabel={`Adjusted for ${servings} servings`}>
                                                                {servings} {servings === 1 ? 'serving' : 'servings'}
                                                            </Text>
                                                            <GlassPressable
                                                                style={styles.servingsButton}
                                                                onPress={() => stepServings(1)}
                                                                disabled={servings! >= range.max}
                                                                hitSlop={8}
                                                                accessibilityRole="button"
                                                                accessibilityLabel="More servings"
                                                            >
                                                                <Ionicons name="add" size={16} color={servings! >= range.max ? inkFaint : primary} />
                                                            </GlassPressable>
                                                        </View>
                                                    ) : draftYield !== null ? (
                                                        // Declaring the yield, not scaling by it: the ± moves
                                                        // a number that is about to be written onto the
                                                        // recipe, and the amounts below stay put until it is.
                                                        <View style={styles.servingsStepper}>
                                                            <GlassPressable
                                                                style={styles.servingsButton}
                                                                onPress={() => stepDraftYield(-1)}
                                                                disabled={draftYield <= range.min || isSavingYield}
                                                                hitSlop={8}
                                                                accessibilityRole="button"
                                                                accessibilityLabel="Fewer servings"
                                                            >
                                                                <Ionicons name="remove" size={16} color={draftYield <= range.min ? inkFaint : primary} />
                                                            </GlassPressable>
                                                            <Text style={styles.servingsValue}>
                                                                {draftYield} {draftYield === 1 ? 'serving' : 'servings'}
                                                            </Text>
                                                            <GlassPressable
                                                                style={styles.servingsButton}
                                                                onPress={() => stepDraftYield(1)}
                                                                disabled={draftYield >= range.max || isSavingYield}
                                                                hitSlop={8}
                                                                accessibilityRole="button"
                                                                accessibilityLabel="More servings"
                                                            >
                                                                <Ionicons name="add" size={16} color={draftYield >= range.max ? inkFaint : primary} />
                                                            </GlassPressable>
                                                            <GlassPressable
                                                                style={[styles.servingsButton, styles.servingsConfirm]}
                                                                onPress={confirmYield}
                                                                disabled={isSavingYield}
                                                                hitSlop={8}
                                                                accessibilityRole="button"
                                                                accessibilityLabel="Save how many this recipe serves"
                                                            >
                                                                {isSavingYield
                                                                    ? <ActivityIndicator size="small" color="#fff" />
                                                                    : <Ionicons name="checkmark" size={16} color="#fff" />}
                                                            </GlassPressable>
                                                        </View>
                                                    ) : canDeclareYield ? (
                                                        // Nothing to scale from until someone says what these
                                                        // amounts feed. Every recipe written before the field
                                                        // existed is in this state, which is most of a
                                                        // cookbook, so it is asked for here rather than left
                                                        // to be found in the editor.
                                                        <GlassPressable
                                                            style={styles.setServingsChip}
                                                            onPress={() => setDraftYield(usual ?? 4)}
                                                            accessibilityRole="button"
                                                            accessibilityLabel="Set how many this recipe serves"
                                                        >
                                                            <Ionicons name="people-outline" size={14} color={primary} />
                                                            <Text style={styles.setServingsChipText}>Set servings</Text>
                                                        </GlassPressable>
                                                    ) : (
                                                        <Text style={styles.sectionCount}>{recipe.ingredients.length}</Text>
                                                    )}
                                                </View>
                                                {draftYield !== null ? (
                                                    <View style={styles.scaleNoteRow}>
                                                        <Ionicons name="help-circle-outline" size={14} color={inkMuted} />
                                                        <Text style={styles.scaleNoteText}>
                                                            How many people do these amounts feed? Save it and the
                                                            list can shop it for your household.
                                                        </Text>
                                                    </View>
                                                ) : !!scaleNote && (
                                                    <View style={styles.scaleNoteRow}>
                                                        <Ionicons name="people-outline" size={14} color={inkMuted} />
                                                        <Text style={styles.scaleNoteText}>{scaleNote}</Text>
                                                    </View>
                                                )}
                                                <View style={styles.ingredientCard}>
                                                    {ingredients.map((ing, index) => {
                                                        // Amounts read as a cook would write them — "1½ cups",
                                                        // not the "1.5 cup" that is stored — and a tap on a
                                                        // convertible one swaps the unit for this reading only.
                                                        const view = displayQuantity(ing.quantity, unitChoices[index]);
                                                        return (
                                                            <Pressable
                                                                key={index}
                                                                style={({ pressed }) => [
                                                                    styles.ingredientRow,
                                                                    index > 0 && styles.ingredientDivider,
                                                                    pressed && view.convertible && styles.ingredientRowPressed,
                                                                ]}
                                                                onPress={view.convertible ? () => cycleUnit(index, view.cycle, view.unit) : undefined}
                                                                disabled={!view.convertible}
                                                                accessibilityRole={view.convertible ? 'button' : undefined}
                                                                accessibilityLabel={
                                                                    view.convertible
                                                                        ? `${view.text} ${ing.name}. Tap to change units.`
                                                                        : undefined
                                                                }
                                                            >
                                                                <View style={styles.ingredientDot} />
                                                                <Text style={styles.ingredientText}>
                                                                    {!!view.text && (
                                                                        <Text style={[styles.ingredientQuantity, view.converted && styles.ingredientQuantityConverted]}>
                                                                            {view.text}{' '}
                                                                        </Text>
                                                                    )}
                                                                    {ing.name}
                                                                </Text>
                                                                {/* Only on the rows a tap does something to —
                                                                    it is the affordance as much as the hint. */}
                                                                {view.convertible && (
                                                                    <Ionicons name="swap-horizontal" size={14} color={view.converted ? primary : inkFaint} style={styles.ingredientSwap} />
                                                                )}
                                                            </Pressable>
                                                        );
                                                    })}
                                                </View>

                                                <View style={styles.sectionHeader}>
                                                    <Text style={styles.sectionTitle}>Instructions</Text>
                                                    <Text style={styles.sectionCount}>
                                                        {recipe.instructions.length} {recipe.instructions.length === 1 ? 'step' : 'steps'}
                                                    </Text>
                                                </View>
                                            </View>
                                        </>
                                    }
                                    data={recipe.instructions}
                                    keyExtractor={(_, index) => `instr-${index}`}
                                    renderItem={({ item, index }) => (
                                        <View style={styles.bodyContainer}>
                                            {/* The number sits in its own column, so a step that runs to a
                                                second line stays lined up with itself instead of tucking
                                                back under the digit. The rule below each number carries the
                                                eye down to the next one. */}
                                            <View style={styles.stepRow}>
                                                <View style={styles.stepMarker}>
                                                    <View style={styles.stepBadge}>
                                                        <Text style={styles.stepNumber}>{index + 1}</Text>
                                                    </View>
                                                    {index < recipe.instructions.length - 1 && <View style={styles.stepConnector} />}
                                                </View>
                                                {/* Prose, but any oven temperature in it is tappable to
                                                    read in the other scale — the ingredient list's unit
                                                    conversion, brought to the steps. */}
                                                <InstructionText step={item} style={styles.stepText} />
                                            </View>
                                        </View>
                                    )}
                                    ListFooterComponent={<View style={[styles.listFooterSpacer, { height: 112 + insets.bottom }]} />}
                                    showsVerticalScrollIndicator={false}
                                />

                                {/* Three full-width labelled buttons did not fit on a phone — the
                                    last one clipped its own text. The two that are shortcuts are
                                    now icon tiles at a fixed width, which leaves the one that
                                    changes something the room to be a real button at any width. */}
                                <GlassSurface style={[styles.footer, { bottom: Math.max(insets.bottom, 12) }]} intensity={85}>
                                    {/* Only where there is something to follow.
                                        A recipe with no steps — an import that
                                        found ingredients and nothing else —
                                        would open a cook mode with an empty
                                        screen and a progress bar reading
                                        "0 of 0". */}
                                    {recipe.instructions.length > 0 && (
                                        <GlassPressable
                                            style={styles.actionTile}
                                            onPress={() => setIsCooking(true)}
                                            accessibilityRole="button"
                                            accessibilityLabel="Start cooking"
                                        >
                                            <Ionicons name="flame-outline" size={20} color={primary} />
                                            <Text style={styles.actionTileText}>Cook</Text>
                                        </GlassPressable>
                                    )}

                                    {/* Nothing to add: this recipe is already on the plan. */}
                                    {!inMealPlan && (
                                        <GlassPressable
                                            style={styles.actionTile}
                                            onPress={() => setIsMealPlanModalVisible(true)}
                                            accessibilityRole="button"
                                            accessibilityLabel="Add to meal plan"
                                        >
                                            <Ionicons name="calendar-outline" size={20} color={primary} />
                                            <Text style={styles.actionTileText}>Plan</Text>
                                        </GlassPressable>
                                    )}

                                    {/* Existing Add to Cookbook Button */}
                                    <GlassPressable
                                        style={[styles.primaryButton, isConfirmingRemove && styles.removeButton]}
                                        onPress={handleCookbookButtonPress}
                                        disabled={isToggling}
                                        accessibilityRole="button"
                                        accessibilityLabel={isConfirmingRemove ? "Confirm removal from cookbook" : isCurrentlyInCookbook ? "Remove from cookbook" : "Add to cookbook"}
                                    >
                                        {isToggling ? (
                                            <ActivityIndicator color="#fff" />
                                        ) : (
                                            <>
                                                <Ionicons
                                                    name={isConfirmingRemove ? "trash-outline" : (isCurrentlyInCookbook ? "bookmark" : "bookmark-outline")}
                                                    size={20}
                                                    color="#fff"
                                                />
                                                {/* The longest label ("Add to Cookbook") still needs
                                                    every point of a small phone's footer, so it is
                                                    allowed to shrink a little before it truncates. */}
                                                <Text style={styles.primaryButtonText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
                                                    {isConfirmingRemove ? "Confirm?" : (isCurrentlyInCookbook ? "In Cookbook" : "Add to Cookbook")}
                                                </Text>
                                            </>
                                        )}
                                    </GlassPressable>
                                </GlassSurface>
                            </>
                        )}
                    </View>
                </View>

                {/* COOK MODE LIVES INSIDE THIS MODAL, NOT BESIDE IT.
                    It used to be a second <Modal> alongside this one, and on
                    iOS that meant it never appeared: both were presented from
                    the SCREEN's view controller, and a view controller that is
                    already presenting one modal silently refuses the next. The
                    Cook button did nothing at all.
                    Rendering it here instead needs no second presentation. The
                    sheet's Modal is already transparent and full-screen — the
                    85% card is just a child of it — so an absolutely filled
                    view over the top is the full-bleed surface cook mode wants,
                    with the recipe still mounted underneath to come back to.
                    Still conditional, so `useKeepAwake` only holds the screen on
                    while somebody is actually cooking. */}
                {isCooking && recipe && (
                    <View style={styles.cookModeOverlay}>
                        {/* The factor the reader is looking at, not the one the
                            shop was done at: they have just adjusted the
                            amounts, and cook mode is where they are about to act
                            on them. */}
                        <CookMode recipe={recipe} scale={factor} onClose={() => setIsCooking(false)} />
                    </View>
                )}

                {/* Also inside, for the same reason: presented from this sheet's
                    own view controller rather than from the screen's, which is
                    busy presenting this sheet. */}
                <AddToMealPlanModal
                    isVisible={isMealPlanModalVisible}
                    onClose={() => setIsMealPlanModalVisible(false)}
                    recipe={recipe}
                />
            </Modal>
        </>
    );
}

const styles = StyleSheet.create({
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,37,28,0.32)' },
    cookModeOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: '#F5F5EF' },
    modalContainer: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '93%' },
    modalContent: { flex: 1, backgroundColor: '#F5F5EF', borderTopLeftRadius: 34, borderTopRightRadius: 34, overflow: 'hidden' },
    header: { flexDirection: 'row', alignItems: 'center', gap: 3, padding: 4, position: 'absolute', top: 16, right: 16, zIndex: 10, borderRadius: 25 },
    closeButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
    moreButton: { width: 38, height: 38, borderRadius: 19, justifyContent: 'center', alignItems: 'center' },
    loaderContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    heroImage: { width: '100%', height: 278, backgroundColor: '#DCEDE2' },
    recipeImage: { width: '100%', height: '100%', resizeMode: 'cover' },
    recipeImagePlaceholder: { flex: 1, backgroundColor: '#DCE9DB', justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
    heroOrb: { position: 'absolute', width: 280, height: 280, borderRadius: 140, backgroundColor: '#E9CBB6', top: -120, right: -70 },
    heroCategory: { position: 'absolute', bottom: 18, left: 22, borderRadius: 17, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
    heroCategoryText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.3, color: ink },
    bodyContainer: { paddingHorizontal: 24 },
    titleContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 25, marginBottom: 9 },
    recipeTitle: { fontSize: 31, lineHeight: 36, fontWeight: '700', letterSpacing: -1.2, color: ink, flex: 1, marginRight: 15 },
    recipeAuthor: { fontSize: 13, color: inkMuted },
    recipeAuthorName: { color: primary, fontWeight: '600' },
    sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 11, minHeight: 28 },
    sourceText: { fontSize: 12, color: inkMuted, flexShrink: 1 },
    editButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: primary, justifyContent: 'center', alignItems: 'center', shadowColor: primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 3 },
    recipeDescription: { fontSize: 15, lineHeight: 24, color: inkMuted, marginTop: 17 },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 18 },
    tag: { backgroundColor: accentSoft, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999 },
    tagText: { fontSize: 11, fontWeight: '600', color: primary, textTransform: 'capitalize' },
    sectionHeader: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between', marginTop: 30, marginBottom: 14 },
    sectionTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.65, color: ink },
    sectionCount: { fontSize: 12, color: inkMuted },
    scaleNoteRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -4, marginBottom: 12 },
    scaleNoteText: { flex: 1, fontSize: 12, lineHeight: 18, color: inkMuted },
    servingsStepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: accentSoft, borderRadius: 999, padding: 4, gap: 2 },
    servingsButton: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#FFF', alignItems: 'center', justifyContent: 'center' },
    servingsValue: { minWidth: 74, textAlign: 'center', fontSize: 12, fontWeight: '700', color: primary },
    servingsConfirm: { backgroundColor: primary, marginLeft: 2 },
    setServingsChip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: accentSoft, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 9 },
    setServingsChipText: { fontSize: 12, fontWeight: '700', color: primary },
    ingredientCard: { backgroundColor: surface, borderRadius: 25, paddingHorizontal: 18, paddingVertical: 3, borderWidth: 1, borderColor: '#FFF' },
    ingredientRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 14 },
    ingredientRowPressed: { opacity: 0.6 },
    ingredientDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hairline },
    ingredientDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: primary, marginTop: 8, marginRight: 12 },
    ingredientText: { flex: 1, fontSize: 15, lineHeight: 23, color: ink },
    ingredientQuantity: { fontWeight: '700' },
    ingredientQuantityConverted: { color: primary },
    ingredientSwap: { marginLeft: 10, marginTop: 5 },
    stepRow: { flexDirection: 'row', alignItems: 'flex-start' },
    stepMarker: { width: 34, alignItems: 'center', alignSelf: 'stretch' },
    stepBadge: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#DCEDE2', alignItems: 'center', justifyContent: 'center' },
    stepNumber: { fontSize: 13, fontWeight: '700', color: primary },
    stepConnector: { flex: 1, width: 1, backgroundColor: hairline, marginTop: 7, marginBottom: 7 },
    stepText: { flex: 1, fontSize: 16, lineHeight: 26, color: ink, marginLeft: 15, marginTop: 3, paddingBottom: 26 },
    listFooterSpacer: { height: 120 },
    footer: { position: 'absolute', left: 12, right: 12, padding: 8, borderRadius: 30, flexDirection: 'row', alignItems: 'stretch', gap: 7 },
    actionTile: { width: 58, height: 55, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.62)', alignItems: 'center', justifyContent: 'center', gap: 3 },
    actionTileText: { color: primary, fontSize: 10, fontWeight: '700', letterSpacing: 0.2 },
    primaryButton: { flex: 1, minHeight: 55, backgroundColor: primary, borderRadius: 22, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', paddingHorizontal: 10 },
    primaryButtonText: { color: '#FFF', fontSize: 14, fontWeight: '700', marginLeft: 7, flexShrink: 1 },
    removeButton: { backgroundColor: '#B8534B' },
});
