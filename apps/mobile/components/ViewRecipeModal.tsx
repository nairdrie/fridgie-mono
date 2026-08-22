// components/ViewRecipeModal.tsx
import { useAuth } from '@/context/AuthContext';
import { Recipe } from '@/types/types';
import { accentSoft, hairline, ink, inkFaint, inkMuted, primary, surface } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { scaleIngredients } from '@/utils/servings';
import { addUserCookbookRecipe, getRecipe, removeUserCookbookRecipe } from '../utils/api';
import AddToMealPlanModal from './AddToMealPlanModal'; // Import the new component
import CookMode from './CookMode';

interface ViewRecipeModalProps {
    isVisible: boolean;
    onClose: () => void;
    recipeId: string | null;
    onEdit: (recipe: Recipe) => void;
    isInCookbook: boolean;
    onCookbookUpdate: () => void;
    /**
     * The factor this recipe's ingredients were scaled by when they went on a
     * shopping list — `Meal.scale`, passed only when the recipe is being opened
     * from a planned meal.
     *
     * Absent everywhere else on purpose: in the cookbook, in Explore, and on a
     * profile there is no shop to agree with, and a recipe should read as its
     * author wrote it.
     */
    scale?: number;
}

// TODO: ensure forking is working. (if I add to meal plan or cookbook, we dont need to. unless i want to edit)
// TODO: author, likes, comments 
// TODO: report recipe (for image or inappropriate content)

export default function ViewRecipeModal({ isVisible, onClose, recipeId, onEdit, isInCookbook, onCookbookUpdate, scale = 1 }: ViewRecipeModalProps) {
    const [recipe, setRecipe] = useState<Recipe | null>(null);
    const [isFetching, setIsFetching] = useState(false);
    const [isCurrentlyInCookbook, setIsCurrentlyInCookbook] = useState(isInCookbook);
    const [isToggling, setIsToggling] = useState(false);
    const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);

    const { user } = useAuth();

    // What the cook actually needs in front of them: the amounts the shopping
    // was done against. Recomputing from the current household size instead
    // would let this screen quietly disagree with what is in the cupboard.
    const ingredients = useMemo(
        () => scaleIngredients(recipe?.ingredients ?? [], scale),
        [recipe?.ingredients, scale],
    );
    const scaleNote = useMemo(() => {
        if (scale === 1) return recipe?.servings ? `Serves ${recipe.servings}` : null;
        const written = recipe?.servings ? ` · written for ${recipe.servings}` : '';
        return `Scaled ${scale > 1 ? 'up' : 'down'}${written}`;
    }, [scale, recipe?.servings]);

    // [NEW] State for the meal plan modal
    const [isMealPlanModalVisible, setIsMealPlanModalVisible] = useState(false);
    const [isCooking, setIsCooking] = useState(false);

    useEffect(() => {
        if (isVisible) {
            setIsCurrentlyInCookbook(isInCookbook);
        } else {
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
    }, [recipeId, isVisible, isInCookbook]);

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

    const handleToggleCookbook = async () => {
        if (!recipe) return;
        setIsToggling(true);

        const originalStatus = isCurrentlyInCookbook;
        setIsCurrentlyInCookbook(!originalStatus); // Optimistic update

        try {
            if (originalStatus) {
                await removeUserCookbookRecipe(recipe.id);
            } else {
                await addUserCookbookRecipe(recipe.id);
            }
            onCookbookUpdate();
        } catch (error) {
            console.error("Failed to toggle cookbook status:", error);
            setIsCurrentlyInCookbook(originalStatus); // Rollback
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

    return (
        <>
            <Modal
                animationType="slide"
                transparent={true}
                visible={isVisible}
                onRequestClose={handleClose}
            >
                <Pressable style={styles.modalBackdrop} onPress={handleClose} />
                <View style={styles.modalContainer}>
                    <View style={styles.modalContent}>
                        <View style={styles.header}>
                            <TouchableOpacity style={styles.closeButton} onPress={handleClose}>
                                <Ionicons name="close-circle" size={32} color="#ccc" />
                            </TouchableOpacity>
                        </View>

                        {isFetching && (<View style={styles.loaderContainer}><ActivityIndicator size="large" /></View>)}

                        {recipe && (
                            <>
                                <FlatList
                                    style={{ flex: 1 }}
                                    ListHeaderComponent={
                                        <>
                                            <Image
                                                source={recipe.photoURL ? { uri: recipe.photoURL } : require('../assets/images/plate.png')}
                                                style={styles.recipeImage}
                                            />
                                            <View style={styles.bodyContainer}>
                                                <View style={styles.titleContainer}>
                                                    <Text style={styles.recipeTitle}>{recipe.name}</Text>
                                                    {/* Shown on everyone's recipes, not just your own. On
                                                        someone else's it makes a copy, and says so first. */}
                                                    <TouchableOpacity
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
                                                    </TouchableOpacity>
                                                </View>
                                                { recipe.authorName &&
                                                  <Text style={styles.recipeAuthor}>by <Text style={styles.recipeAuthorName}>{recipe.authorName}</Text></Text>
                                                }

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
                                                    <Text style={styles.sectionCount}>{recipe.ingredients.length}</Text>
                                                </View>
                                                {!!scaleNote && (
                                                    <View style={styles.scaleNoteRow}>
                                                        <Ionicons name="people-outline" size={14} color={inkMuted} />
                                                        <Text style={styles.scaleNoteText}>{scaleNote}</Text>
                                                    </View>
                                                )}
                                                <View style={styles.ingredientCard}>
                                                    {ingredients.map((ing, index) => (
                                                        <View key={index} style={[styles.ingredientRow, index > 0 && styles.ingredientDivider]}>
                                                            <View style={styles.ingredientDot} />
                                                            <Text style={styles.ingredientText}>
                                                                {!!ing.quantity && <Text style={styles.ingredientQuantity}>{ing.quantity} </Text>}
                                                                {ing.name}
                                                            </Text>
                                                        </View>
                                                    ))}
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
                                                <Text style={styles.stepText}>{item}</Text>
                                            </View>
                                        </View>
                                    )}
                                    ListFooterComponent={<View style={styles.listFooterSpacer} />}
                                    showsVerticalScrollIndicator={false}
                                />

                                <View style={styles.footer}>
                                    {/* Only where there is something to follow.
                                        A recipe with no steps — an import that
                                        found ingredients and nothing else —
                                        would open a cook mode with an empty
                                        screen and a progress bar reading
                                        "0 of 0". */}
                                    {recipe.instructions.length > 0 && (
                                        <TouchableOpacity
                                            style={styles.secondaryButton}
                                            onPress={() => setIsCooking(true)}
                                            accessibilityRole="button"
                                            accessibilityLabel="Start cooking"
                                        >
                                            <Ionicons name="flame-outline" size={20} color={primary} />
                                            <Text style={styles.secondaryButtonText}>Cook</Text>
                                        </TouchableOpacity>
                                    )}

                                    {/* [NEW] Add to Meal Plan Button */}
                                    <TouchableOpacity
                                        style={styles.secondaryButton}
                                        onPress={() => setIsMealPlanModalVisible(true)}
                                    >
                                        <Ionicons name="calendar-outline" size={20} color={primary} />
                                        <Text style={styles.secondaryButtonText}>Add to Plan</Text>
                                    </TouchableOpacity>

                                    {/* Existing Add to Cookbook Button */}
                                    <TouchableOpacity
                                        style={[styles.primaryButton, isConfirmingRemove && styles.removeButton]}
                                        onPress={handleCookbookButtonPress}
                                        disabled={isToggling}
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
                                                <Text style={styles.primaryButtonText}>
                                                    {isConfirmingRemove ? "Confirm?" : (isCurrentlyInCookbook ? "In Cookbook" : "Add to Cookbook")}
                                                </Text>
                                            </>
                                        )}
                                    </TouchableOpacity>
                                </View>
                            </>
                        )}
                    </View>
                </View>
            </Modal>
            
            {/* [NEW] Render the reusable modal */}
            <AddToMealPlanModal
                isVisible={isMealPlanModalVisible}
                onClose={() => setIsMealPlanModalVisible(false)}
                recipe={recipe}
            />

            {/* Its own full-screen Modal, not a view inside the sheet above.
                The sheet is 85% tall with a dimmed backdrop, which is right for
                reading a recipe and wrong for following one at arm's length —
                and `useKeepAwake` should only hold the screen on while the cook
                view is genuinely mounted. */}
            <Modal
                animationType="slide"
                visible={isCooking && !!recipe}
                onRequestClose={() => setIsCooking(false)}
                presentationStyle="pageSheet"
            >
                {recipe && (
                    <CookMode recipe={recipe} scale={scale} onClose={() => setIsCooking(false)} />
                )}
            </Modal>
        </>
    );
}

const styles = StyleSheet.create({
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
    modalContainer: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '85%' },
    modalContent: { flex: 1, backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
    header: { alignItems: 'flex-end', padding: 10, position: 'absolute', top: 0, right: 0, zIndex: 10 },
    closeButton: { backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 16 },
    loaderContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    recipeImage: { width: '100%', height: 220, backgroundColor: '#f0f0f0', resizeMode: 'cover' },
    bodyContainer: { paddingHorizontal: 20 },
    titleContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 20, marginBottom: 4 },
    recipeTitle: { fontSize: 26, fontWeight: '700', letterSpacing: -0.4, color: ink, flex: 1, marginRight: 10 },
    recipeAuthor: { fontSize: 14, color: inkMuted },
    recipeAuthorName: { color: primary, fontWeight: '600' },
    editButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: primary, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 3, elevation: 4 },
    recipeDescription: { fontSize: 15, lineHeight: 23, color: inkMuted, marginTop: 12 },

    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
    tag: { backgroundColor: accentSoft, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
    tagText: { fontSize: 12, fontWeight: '600', color: primary, textTransform: 'capitalize' },

    // Small caps eyebrow instead of the old ruled heading — the ingredient card
    // and the step column already give the sections their own shape.
    sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 28, marginBottom: 12 },
    sectionTitle: { fontSize: 13, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', color: inkMuted },
    sectionCount: { fontSize: 13, color: inkFaint },
    scaleNoteRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -8, marginBottom: 10 },
    scaleNoteText: { fontSize: 13, color: inkMuted },

    ingredientCard: { backgroundColor: surface, borderRadius: 16, paddingHorizontal: 16 },
    ingredientRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 11 },
    ingredientDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hairline },
    ingredientDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: primary, marginTop: 8, marginRight: 12 },
    ingredientText: { flex: 1, fontSize: 16, lineHeight: 22, color: ink },
    ingredientQuantity: { fontWeight: '700' },

    stepRow: { flexDirection: 'row', alignItems: 'flex-start' },
    stepMarker: { width: 28, alignItems: 'center', alignSelf: 'stretch' },
    stepBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: accentSoft, alignItems: 'center', justifyContent: 'center' },
    stepNumber: { fontSize: 13, fontWeight: '700', color: primary },
    stepConnector: { flex: 1, width: 2, borderRadius: 1, backgroundColor: hairline, marginTop: 6 },
    // flex: 1 keeps the wrapped lines inside this column, clear of the number.
    stepText: { flex: 1, fontSize: 16, lineHeight: 25, color: ink, marginLeft: 14, marginTop: 3, paddingBottom: 22 },
    listFooterSpacer: { height: 12 },
    // [UPDATED] Footer styles for two buttons
    footer: { padding: 20, borderTopWidth: 1, borderTopColor: '#f0f0f0', backgroundColor: '#fff', flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
    // [UPDATED] Primary button now has flex: 1
    primaryButton: { flex: 1, backgroundColor: primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' },
    primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold', marginLeft: 8 },
    removeButton: { backgroundColor: '#c94444' },
    // [NEW] Secondary button styles
    secondaryButton: { flex: 1, backgroundColor: '#fff', paddingVertical: 14, borderRadius: 12, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', borderWidth: 1, borderColor: primary },
    secondaryButtonText: { color: primary, fontSize: 16, fontWeight: 'bold', marginLeft: 8 },
});