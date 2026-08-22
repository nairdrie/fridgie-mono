// components/Cookbook.tsx
import { useAuth } from '@/context/AuthContext';
import { useCookbook } from '@/context/CookbookContext';
import { Item, Meal, Recipe } from '@/types/types';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    RefreshControl,
    StyleSheet,
    Text,
    TextInput,
    View
} from 'react-native';
import AddEditRecipeModal from './AddEditRecipeModal';
import AddToMealPlanModal from './AddToMealPlanModal'; // Import the new component
import RecipeCard from './RecipeCard';
import ViewRecipeModal from './ViewRecipeModal';

interface CookbookProps {
    recipes: Recipe[];
    isLoading: boolean;
    onRefresh: () => void;
    /**
     * Whose shelf this is. On somebody else's profile the recipes here are
     * theirs: adding one puts a copy on the VIEWER's shelf and changes nothing
     * about the list on screen, so there is nothing here to refetch afterwards.
     */
    isOwnCookbook?: boolean;
}

export default function Cookbook({ recipes, isLoading, onRefresh, isOwnCookbook = true }: CookbookProps) {
    const [searchTerm, setSearchTerm] = useState('');
    const [isRefreshing, setIsRefreshing] = useState(false);

    // State for the new modal
    const [isMealPlanModalVisible, setIsMealPlanModalVisible] = useState(false);
    const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);

    // State for view/edit modals
    const [recipeToViewId, setRecipeToViewId] = useState<string | null>(null);
    const [recipeToEdit, setRecipeToEdit] = useState<Recipe | null>(null);

    const { user } = useAuth();
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

    const filteredRecipes = useMemo(() => {
        if (!searchTerm) return recipes;
        return recipes.filter(recipe =>
            recipe.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            recipe.description.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }, [recipes, searchTerm]);

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
        setRecipeToEdit(null);
        if (previousId && previousId !== savedRecipe.id) {
            try {
                await addRecipe(savedRecipe.id);
            } catch (error) {
                console.error('Failed to add the copied recipe to the cookbook', error);
                Alert.alert('Saved, but not filed', "Your copy was saved but couldn't be added to your cookbook.");
            }
        }
        onRefresh();
    };

    if (isLoading) {
        return <ActivityIndicator size="large" color={primary} style={{ marginTop: 40 }} />;
    }

    if (!recipes || recipes.length === 0) {
        return (
            <View style={styles.feedPlaceholder}>
                <Ionicons name="receipt-outline" size={48} color="#ccc" />
                <Text style={styles.feedPlaceholderText}>Nothing to see here.</Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.searchContainer}>
                <Ionicons name="search" size={20} color="#999" style={styles.searchIcon} />
                <TextInput
                    style={styles.searchInput}
                    placeholder="Search for recipes..."
                    value={searchTerm}
                    placeholderTextColor={'#999'}
                    onChangeText={setSearchTerm}
                />
            </View>

            <FlatList
                data={filteredRecipes}
                keyExtractor={(item) => item.id}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                    <>
                        {/* {
                            item.authorUid != user?.uid && (
                                 <View style={styles.repostRow}>
                                    <View style={styles.repostContainer}>
                                        <Ionicons name="repeat" size={16} color="black" />
                                        <Text style={styles.repostAuthor}>{item.authorName}</Text>
                                    </View>
                                 </View>
                            )
                        } */}
                        <RecipeCard
                            recipe={item}
                            onAddToMealPlan={handleAddToMealPlan}
                            onView={handleViewRecipe}
                        />
                    </>
                )}
                contentContainerStyle={{ paddingBottom: 20 }}
                ListEmptyComponent={<Text style={styles.emptyText}>No recipes match your search.</Text>}
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
    searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 12, marginBottom: 16, borderWidth: 1, borderColor: '#e9ecef' },
    searchIcon: { marginRight: 8 },
    searchInput: { flex: 1, height: 44, fontSize: 16 },
    emptyText: { textAlign: 'center', marginTop: 20, color: '#6c757d' },
    feedPlaceholder: { alignItems: 'center', justifyContent: 'center', padding: 40, backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#e9ecef' },
    feedPlaceholderText: { marginTop: 16, fontSize: 16, color: '#6c757d', textAlign: 'center', marginBottom: 20 },
    repostRow: {
        flexDirection: 'row',
        justifyContent: 'flex-start'
    },
    repostContainer: {
        marginLeft: 10,
        backgroundColor: '#d0f1ccff',
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingVertical: 2,
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8
    },
    repostAuthor: {
        color: 'black',
        fontSize: 12,
        marginLeft: 5
    }
});