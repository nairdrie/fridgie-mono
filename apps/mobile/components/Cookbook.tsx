// components/Cookbook.tsx
import { useAuth } from '@/context/AuthContext';
import { Item, Meal, Recipe } from '@/types/types';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useMemo, useState } from 'react';
import {
    ActivityIndicator,
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
}

export default function Cookbook({ recipes, isLoading, onRefresh }: CookbookProps) {
    const [searchTerm, setSearchTerm] = useState('');
    const [isRefreshing, setIsRefreshing] = useState(false);

    // State for the new modal
    const [isMealPlanModalVisible, setIsMealPlanModalVisible] = useState(false);
    const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);

    // State for view/edit modals
    const [recipeToViewId, setRecipeToViewId] = useState<string | null>(null);
    const [mealForRecipeEdit, setMealForRecipeEdit] = useState<Meal | null>(null);

    const { user } = useAuth();

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
        const mealFromRecipe: Meal = {
            id: recipe.id,
            listId: 'cookbook-context',
            name: recipe.name,
            recipeId: recipe.id,
        };
        setRecipeToViewId(null);
        setMealForRecipeEdit(mealFromRecipe);
    };

    const handleRecipeSaved = (updatedMeal: Meal, newItems: Item[]) => {
        setMealForRecipeEdit(null);
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
                    placeholder="Search recipes in your cookbook..."
                    value={searchTerm}
                    placeholderTextColor={'#999'}
                    onChangeText={setSearchTerm}
                />
            </View>

            <FlatList
                data={filteredRecipes}
                keyExtractor={(item) => item.id}
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
            
            <ViewRecipeModal
                isVisible={!!recipeToViewId}
                onClose={() => setRecipeToViewId(null)}
                recipeId={recipeToViewId}
                onEdit={handleEditRecipe}
                isInCookbook={recipes.some(r => r.id === recipeToViewId)}
                onCookbookUpdate={onRefresh}
            />
            
            <AddEditRecipeModal
                isVisible={!!mealForRecipeEdit}
                onClose={() => setMealForRecipeEdit(null)}
                mealForRecipe={mealForRecipeEdit}
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