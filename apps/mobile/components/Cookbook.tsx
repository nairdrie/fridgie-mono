// components/Cookbook.tsx
import { useCookbook } from '@/context/CookbookContext';
import { useCookbookFilter } from '@/hooks/useCookbookFilter';
import { Item, Meal, Recipe } from '@/types/types';
import { ink, inkMuted, primary } from '@/utils/styles';
import { GlassSurface } from '@/components/ui/Glass';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    RefreshControl,
    StyleProp,
    StyleSheet,
    Text,
    TextInput,
    View,
    ViewStyle
} from 'react-native';
import AddEditRecipeModal from './AddEditRecipeModal';
import AddToMealPlanModal from './AddToMealPlanModal'; // Import the new component
import CookbookFilterBar, { CookbookGroupHeader } from './CookbookFilterBar';
import RecipeCard from './RecipeCard';
import ViewRecipeModal from './ViewRecipeModal';

interface CookbookProps {
    recipes: Recipe[];
    isLoading: boolean;
    onRefresh: () => void | Promise<void>;
    /** Content above the cookbook shares its virtualized scroll surface. */
    header?: React.ReactElement;
    contentContainerStyle?: StyleProp<ViewStyle>;
    /**
     * Whose shelf this is. On somebody else's profile the recipes here are
     * theirs: adding one puts a copy on the VIEWER's shelf and changes nothing
     * about the list on screen, so there is nothing here to refetch afterwards.
     */
    isOwnCookbook?: boolean;
}

export default function Cookbook({ recipes, isLoading, onRefresh, isOwnCookbook = true, header, contentContainerStyle }: CookbookProps) {
    const filter = useCookbookFilter(recipes);
    const [isRefreshing, setIsRefreshing] = useState(false);

    // State for the new modal
    const [isMealPlanModalVisible, setIsMealPlanModalVisible] = useState(false);
    const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);

    // State for view/edit modals
    const [recipeToViewId, setRecipeToViewId] = useState<string | null>(null);
    const [recipeToEdit, setRecipeToEdit] = useState<Recipe | null>(null);

    const { addRecipe } = useCookbook();

    const handleRefresh = useCallback(async () => {
        setIsRefreshing(true);
        try {
            await onRefresh();
        } catch (error) {
            console.error('Failed to refresh recipes', error);
        } finally {
            setIsRefreshing(false);
        }
    }, [onRefresh]);

    const handleAddToMealPlan = (recipe: Recipe) => {
        setSelectedRecipe(recipe);
        setIsMealPlanModalVisible(true);
    };

    const handleViewRecipe = (recipeId: string) => {
        setRecipeToViewId(recipeId);
    };

    const handleEditRecipe = (recipe: Recipe) => {
        setRecipeToViewId(null);
        setRecipeToEdit(recipe);
    };

    /**
     * This is somebody else's shelf, so nothing here is being replaced — the
     * copy the server just forked goes onto the viewer's own cookbook, where
     * they will find it on their profile.
     */
    const handleRecipeSaved = async (_meal: Meal | null, _items: Item[], savedRecipe: Recipe) => {
        const previousId = recipeToEdit?.id;
        if (previousId && previousId !== savedRecipe.id) {
            try {
                await addRecipe(savedRecipe.id);
            } catch (error) {
                console.error('Failed to add the copied recipe to the cookbook', error);
                // Keep the editor open so retry files the same saved copy.
                throw error;
            }
        }
        onRefresh();
    };

    return (
        <View style={styles.container}>
            <FlatList
                data={filter.rows}
                keyExtractor={(row) => row.key}
                keyboardShouldPersistTaps="handled"
                ListHeaderComponent={
                    <>
                        {header}
                        {recipes.length > 0 && <>
                            <GlassSurface style={styles.searchContainer} intensity={60}>
                                <Ionicons name="search-outline" size={20} color={primary} style={styles.searchIcon} />
                                <TextInput
                                    style={styles.searchInput}
                                    placeholder="Find a favourite…"
                                    accessibilityLabel="Search this cookbook"
                                    returnKeyType="search"
                                    value={filter.searchTerm}
                                    placeholderTextColor={inkMuted}
                                    onChangeText={filter.setSearchTerm}
                                />
                            </GlassSurface>
                            <CookbookFilterBar
                                chips={filter.chips}
                                selected={filter.category}
                                onSelect={filter.setCategory}
                                sort={filter.sort}
                                onSortChange={filter.setSort}
                            />
                        </>}
                    </>
                }
                renderItem={({ item }) => (
                    item.type === 'header' ? (
                        <CookbookGroupHeader category={item.category} count={item.count} />
                    ) : (
                        <RecipeCard
                            recipe={item.recipe}
                            onAddToMealPlan={handleAddToMealPlan}
                            onView={handleViewRecipe}
                        />
                    )
                )}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={[styles.listContent, contentContainerStyle]}
                ListEmptyComponent={
                    isLoading ? <ActivityIndicator size="large" color={primary} style={styles.loadingIndicator} /> :
                    recipes.length === 0 ? (
                        <View style={styles.feedPlaceholder}>
                            <View style={styles.emptyIcon}><Ionicons name="book-outline" size={32} color={primary} /></View>
                            <Text style={styles.emptyTitle}>{isOwnCookbook ? "Your favourites belong here" : "A cookbook in the making"}</Text>
                            <Text style={styles.feedPlaceholderText}>{isOwnCookbook ? "Save something delicious from Discover, or add a recipe of your own." : "The first recipe is always the start of something good."}</Text>
                        </View>
                    ) : <Text style={styles.emptyText}>No recipes match your search.</Text>
                }
                refreshControl={
                    <RefreshControl
                        refreshing={isRefreshing}
                        onRefresh={handleRefresh}
                        tintColor={primary}
                        colors={[primary]}
                    />
                }
            />

            {/* Render the new modal */}
            <AddToMealPlanModal
                isVisible={isMealPlanModalVisible}
                onClose={() => setIsMealPlanModalVisible(false)}
                recipe={selectedRecipe}
            />
            
            {/* No `isInCookbook` here on purpose. It used to be
                `recipes.some(...)` — true for everything on this list, which is
                only the same question when the list is your own. On another
                user's profile it labelled their whole shelf "In Cookbook" and
                offered to remove recipes the viewer had never added. */}
            <ViewRecipeModal
                isVisible={!!recipeToViewId}
                onClose={() => setRecipeToViewId(null)}
                recipeId={recipeToViewId}
                onEdit={handleEditRecipe}
                onCookbookUpdate={isOwnCookbook ? onRefresh : undefined}
            />
            
            <AddEditRecipeModal
                isVisible={!!recipeToEdit}
                onClose={() => setRecipeToEdit(null)}
                mealForRecipe={null}
                recipeToEdit={recipeToEdit}
                onRecipeSave={handleRecipeSaved}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    listContent: { paddingBottom: 110 },
    loadingIndicator: { marginTop: 40 },
    searchContainer: { flexDirection: 'row', alignItems: 'center', borderRadius: 24, paddingHorizontal: 17, marginBottom: 17 },
    searchIcon: { marginRight: 10 },
    searchInput: { flex: 1, minHeight: 52, fontSize: 15, color: ink, paddingVertical: 12 },
    emptyText: { textAlign: 'center', marginTop: 30, color: inkMuted, fontSize: 15, lineHeight: 22 },
    feedPlaceholder: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 35, backgroundColor: 'rgba(255,255,255,0.65)', borderRadius: 28, borderWidth: 1, borderColor: '#FFF' },
    emptyIcon: { width: 74, height: 74, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: '#DCEDE2', marginBottom: 20 },
    emptyTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.7, color: ink, textAlign: 'center' },
    feedPlaceholderText: { marginTop: 10, fontSize: 14, lineHeight: 22, color: inkMuted, textAlign: 'center' },
});
