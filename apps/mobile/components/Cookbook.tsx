// components/Cookbook.tsx

import { useLists } from '@/context/ListContext';
import { Item, List, Meal, Recipe } from '@/types/types';
import { addRecipeToList } from '@/utils/api'; // You'll need to create this API function
import { getWeekLabel } from '@/utils/date';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Modal,
    SafeAreaView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import AddEditRecipeModal from './AddEditRecipeModal';
import RecipeCard from './RecipeCard';
import ViewRecipeModal from './ViewRecipeModal';

interface CookbookProps {
    recipes: Recipe[];
    isLoading: boolean;
    onRefresh: () => void; 
}

export default function Cookbook({ recipes, isLoading, onRefresh }: CookbookProps) {
    const { allLists, isLoading: areListsLoading } = useLists();
    const [searchTerm, setSearchTerm] = useState('');

    const [isWeekSelectorVisible, setWeekSelectorVisible] = useState(false);
    const [selectedRecipeForMealPlan, setSelectedRecipeForMealPlan] = useState<Recipe | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const [recipeToViewId, setRecipeToViewId] = useState<string | null>(null);
    const [mealForRecipeEdit, setMealForRecipeEdit] = useState<Meal | null>(null);

    const filteredRecipes = useMemo(() => {
        if (!searchTerm) return recipes;
        return recipes.filter(recipe =>
            recipe.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            recipe.description.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }, [recipes, searchTerm]);

    const displayLists = useMemo(() => {
        if (!allLists) return [];

        // Get the start of the current week (assuming Sunday is the first day)
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Normalize to the start of the day
        const startOfThisWeek = new Date(today);
        startOfThisWeek.setDate(today.getDate() - today.getDay());
        const startOfThisWeekTime = startOfThisWeek.getTime();

        return allLists
            .filter(list => {
                const listStartTime = new Date(list.weekStart).getTime();
                // Include the list if its start date is on or after the start of this week
                return listStartTime >= startOfThisWeekTime;
            })
            // Sort the filtered lists chronologically
            .sort((a, b) => new Date(a.weekStart).getTime() - new Date(b.weekStart).getTime());
    }, [allLists]);


     const handleAddToMealPlan = (recipe: Recipe) => {
        setSelectedRecipeForMealPlan(recipe);
        setWeekSelectorVisible(true);
    };

    const handleSelectWeek = async (list: List) => {
        if (!selectedRecipeForMealPlan) return;

        setIsSubmitting(true);
        try {
            // NOTE: You need to implement `addRecipeToList` in your API utils
            await addRecipeToList(list.id, selectedRecipeForMealPlan);
            Alert.alert("Success", `Added "${selectedRecipeForMealPlan.name}" to your meal plan.`);
            setWeekSelectorVisible(false);
            setSelectedRecipeForMealPlan(null);
        } catch (error) {
            console.error("Failed to add recipe to list:", error);
            Alert.alert("Error", "Could not add recipe. Please try again.");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleViewRecipe = (recipeId: string) => {
        setRecipeToViewId(recipeId);
    };

    // Called from ViewRecipeModal's "Edit" button
    const handleEditRecipe = (recipe: Recipe) => {
        // Create a temporary "Meal" object to pass to the unmodified AddEditRecipeModal
        const mealFromRecipe: Meal = {
            id: recipe.id, // Use recipe ID as a stand-in
            listId: 'cookbook-context', // Placeholder
            name: recipe.name,
            recipeId: recipe.id,
        };
        setRecipeToViewId(null); // Close the view modal
        setMealForRecipeEdit(mealFromRecipe); // Open the edit modal
    };

    // Called from AddEditRecipeModal after a recipe is saved
    const handleRecipeSaved = (updatedMeal: Meal, newItems: Item[]) => {
        // `newItems` are ignored here as we're not in a grocery list context
        setMealForRecipeEdit(null); // Close the edit modal
        onRefresh(); // Trigger a refresh of the cookbook list on the profile screen
    };


    if (isLoading) {
        return <ActivityIndicator size="large" color={primary} style={{ marginTop: 40 }} />;
    }

    if (!recipes || recipes.length === 0) {
        return (
            <View style={styles.feedPlaceholder}>
                <Ionicons name="receipt-outline" size={48} color="#ccc" />
                <Text style={styles.feedPlaceholderText}>Your saved recipes will appear here.</Text>
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
                    <RecipeCard
                        recipe={item}
                        onAddToMealPlan={handleAddToMealPlan}
                        onView={handleViewRecipe} // Pass the new handler to the card
                    />
                )}
                contentContainerStyle={{ paddingBottom: 20 }}
                ListEmptyComponent={
                    <Text style={styles.emptyText}>No recipes match your search.</Text>
                }
            />

            <Modal
                visible={isWeekSelectorVisible}
                transparent={true}
                animationType="slide"
                onRequestClose={() => setWeekSelectorVisible(false)}
            >
                <TouchableOpacity style={styles.modalBackdrop} onPress={() => setWeekSelectorVisible(false)} activeOpacity={1}/>
                <SafeAreaView style={styles.modalContent}>
                    <Text style={styles.modalTitle}>Add to Meal Plan</Text>
                    <Text style={styles.modalSubtitle}>Select a week for "{selectedRecipeForMealPlan?.name}"</Text>
                    
                    {areListsLoading ? (
                        <ActivityIndicator />
                    ) : (
                        <FlatList
                            data={displayLists}
                            keyExtractor={(item) => item.id}
                            renderItem={({ item }) => (
                                <TouchableOpacity style={styles.weekItem} onPress={() => handleSelectWeek(item)}>
                                    <View>
                                        <Text style={styles.weekText}>{getWeekLabel(item.weekStart)}</Text>
                                        <Text style={styles.weekSubText}>
                                            {new Date(item.weekStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - {new Date(new Date(item.weekStart).getTime() + 6 * 24 * 60 * 60 * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                        </Text>
                                    </View>
                                    <Ionicons name="chevron-forward" size={22} color="#666" />
                                </TouchableOpacity>
                            )}
                            ListEmptyComponent={<Text style={styles.emptyText}>No meal plans found.</Text>}
                        />
                    )}
                    {isSubmitting && <ActivityIndicator size="large" color={primary} style={styles.submitLoader} />}
                </SafeAreaView>
            </Modal>
            <ViewRecipeModal
                isVisible={!!recipeToViewId}
                onClose={() => setRecipeToViewId(null)}
                recipeId={recipeToViewId}
                onEdit={handleEditRecipe}
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
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
    modalContent: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#f8f9fa', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '60%' },
    modalTitle: { fontSize: 22, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 },
    modalSubtitle: { fontSize: 16, color: '#6c757d', textAlign: 'center', marginBottom: 24 },
    weekItem: { backgroundColor: '#fff', paddingVertical: 16, paddingHorizontal: 20, borderRadius: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#e9ecef' },
    weekText: { fontSize: 16, fontWeight: '500' },
    weekSubText: {
        fontSize: 14,
        color: '#6c757d',
        marginTop: 4,
    },
    submitLoader: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(255, 255, 255, 0.7)' }
});