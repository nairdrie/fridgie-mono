import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import uuid from 'react-native-uuid';

import { Item, Meal, MealPreferences, Recipe } from '@/types/types';
import { primary } from '@/utils/styles';
import { ApiError, getMealPreferences, getMealSuggestions, saveRecipe } from '../utils/api'; // Adjust path if needed

// Define the component's props
interface SuggestionModalProps {
    isVisible: boolean;
    onClose: () => void;
    onAddSelectedMeals: (newMeals: Meal[], newItems: Item[]) => void;
    listId: string;
}

export default function MealSuggestionsModal({ isVisible, onClose, onAddSelectedMeals, listId }: SuggestionModalProps) {
    const [mealSuggestions, setMealSuggestions] = useState<Recipe[]>([]);
    const [selectedSuggestions, setSelectedSuggestions] = useState<Record<string, boolean>>({});
    const [isSuggesting, setIsSuggesting] = useState(false);
    const [vetoedMeals, setVetoedMeals] = useState<string[]>([]);
    const [suggestionModalStep, setSuggestionModalStep] = useState<'confirm' | 'loading' | 'results'>('confirm');
    const [mealPreferences, setMealPreferences] = useState<MealPreferences | null>(null);
    
    const goofyLoadingMessages = [
        'Consulting our chefs...',
        'Rummaging through the pantry...',
        'Asking grandma for her secret recipe...',
        'Warming up the oven...',
    ];
    const [loadingMessage, setLoadingMessage] = useState(goofyLoadingMessages[0]);
    const loadingMessageIndexRef = useRef(0);
    
    const router = useRouter();
    
    // Effect to handle the goofy loading messages
    useEffect(() => {
        if (!isSuggesting) {
            return;
        }

        loadingMessageIndexRef.current = 0;
        setLoadingMessage(goofyLoadingMessages[0]);

        const intervalId = setInterval(() => {
            const nextIndex = loadingMessageIndexRef.current + 1;
            
            if (nextIndex < goofyLoadingMessages.length) {
                loadingMessageIndexRef.current = nextIndex;
                setLoadingMessage(goofyLoadingMessages[nextIndex]);
            } else {
                // We've reached the end, so we stop the interval.
                // The last message will remain displayed.
                clearInterval(intervalId);
            }
        }, 4000);

        // Clean up the interval when the component unmounts or `isSuggesting` becomes false.
        return () => clearInterval(intervalId);
    }, [isSuggesting]);

    // Effect to fetch preferences when the modal becomes visible
    useEffect(() => {
        if (!isVisible) {
            // Reset state when modal is hidden for a fresh start next time
            setSuggestionModalStep('confirm');
            setVetoedMeals([]);
            return;
        }

        const fetchPreferences = async () => {
            setSuggestionModalStep('loading');
            setMealPreferences(null);
            setIsSuggesting(false);

            // TODO: CHECK ON PREFERENCES SETUP FOR NEW USERS
            try {
                const prefs = await getMealPreferences();
                setMealPreferences(prefs);
                setSuggestionModalStep('confirm');
            } catch (error) {
                if (error instanceof ApiError && error.status === 404) {
                    onClose();
                    await AsyncStorage.setItem('pendingAction', 'suggest-meals');
                    router.navigate('/meal-preferences');
                } else {
                    console.error('An unexpected error occurred while fetching preferences:', error);
                    onClose();
                    Alert.alert("Error", "Could not load your meal preferences. Please try again.");
                }
            }
        };

        fetchPreferences();
    }, [isVisible]);

    const handleConfirmAndSuggest = async () => {
        setSuggestionModalStep('loading');
        setIsSuggesting(true);
        setMealSuggestions([]);
        setSelectedSuggestions({});

        try {
            const suggestionsFromApi = await getMealSuggestions();
            const suggestionsWithId = suggestionsFromApi.map(suggestion => ({
                ...suggestion,
                id: uuid.v4() as string,
            }));
            setMealSuggestions(suggestionsWithId);
            setSuggestionModalStep('results');
        } catch (error) {
            console.error('An unexpected error occurred during suggestion:', error);
            onClose();
            Alert.alert("Error", "Could not get meal suggestions. Please try again.");
        } finally {
            setIsSuggesting(false);
        }
    };

    const handleRerollSuggestions = async () => {
        if (isSuggesting) return;

        const currentTitles = mealSuggestions.map(s => s.name);
        const newVetoedList = [...vetoedMeals, ...currentTitles];
        setVetoedMeals(newVetoedList);
        
        setIsSuggesting(true);
        setSelectedSuggestions({});
        setMealSuggestions([]);

        try {
            const suggestionsFromApi = await getMealSuggestions(newVetoedList);
            const suggestionsWithId = suggestionsFromApi.map(suggestion => ({
                ...suggestion,
                id: uuid.v4() as string,
            }));
            setMealSuggestions(suggestionsWithId);
        } catch (error) {
            console.error('An unexpected error occurred during reroll:', error);
            onClose();
        } finally {
            setIsSuggesting(false);
        }
    };

    const handleEditPreferences = async () => {
        onClose();
        await AsyncStorage.setItem('pendingAction', 'suggest-meals');
        router.navigate('/meal-preferences');
    };

    const toggleSuggestionSelection = (recipeId: string) => {
        setSelectedSuggestions((prev) => ({
            ...prev,
            [recipeId]: !prev[recipeId],
        }));
    };

    const handleAddSelectedMeals = async () => {
        const selectedRecipes = mealSuggestions.filter(
            (recipe) => selectedSuggestions[recipe.id]
        );

        if (selectedRecipes.length === 0) {
            onClose();
            return;
        }

        try {
            const savedRecipes = await Promise.all(
                selectedRecipes.map(recipe => saveRecipe(recipe))
            );

            const newMeals: Meal[] = [];
            const newItems: Item[] = [];

            for (const recipe of savedRecipes) {
                const newMeal: Meal = {
                    id: uuid.v4() as string,
                    listId: listId,
                    name: recipe.name,
                    recipeId: recipe.id,
                };
                newMeals.push(newMeal);

                for (const ingredient of recipe.ingredients) {
                    const newItem: Item = {
                        id: uuid.v4() as string,
                        text: ingredient.name.trim(),
                        quantity: ingredient.quantity.trim(),
                        checked: false,
                        listOrder: 'NEEDS-RANK', // Parent will handle ranking
                        isSection: false,
                        mealId: newMeal.id,
                    };
                    newItems.push(newItem);
                }
            }

            onAddSelectedMeals(newMeals, newItems);

        } catch (error) {
            console.error("Failed to add selected meals:", error);
            Alert.alert("Error", "Could not add the selected meals. Please try again.");
        } finally {
            onClose();
        }
    };

    const selectedCount = Object.values(selectedSuggestions).filter(Boolean).length;

    return (
        <Modal
            animationType="slide"
            transparent={true}
            visible={isVisible}
            onRequestClose={onClose}
        >
            <Pressable style={styles.modalBackdrop} onPress={onClose} />
            <View style={styles.modalContent}>
                {suggestionModalStep === 'loading' && (
                    <View style={styles.suggestionLoadingContainer}>
                        <ActivityIndicator size="large" />
                        <Text style={styles.suggestionLoadingText}>
                            {isSuggesting ? loadingMessage : 'Fetching your preferences...'}
                        </Text>
                    </View>
                )}

                {suggestionModalStep === 'confirm' && mealPreferences && (
                    <>
                        <Text style={styles.modalTitle}>Suggest Meals</Text>
                        <ScrollView>
                            <View style={styles.prefsSummaryContainer}>
                                <Text style={styles.prefsSummaryTitle}>Dietary Needs</Text>
                                <Text style={styles.prefsSummaryText}>
                                    {mealPreferences.dietaryNeeds?.join(', ') || 'None specified'}
                                </Text>
                                <Text style={styles.prefsSummaryTitle}>Cooking Styles</Text>
                                <Text style={styles.prefsSummaryText}>
                                    {mealPreferences.cookingStyles?.join(', ') || 'None specified'}
                                </Text>
                                <Text style={styles.prefsSummaryTitle}>Cuisine Type</Text>
                                <Text style={styles.prefsSummaryText}>
                                    {mealPreferences.cuisines?.join(', ') || 'None specified'}
                                </Text>
                                <Text style={styles.prefsSummaryTitle}>Disliked Ingredients</Text>
                                <Text style={styles.prefsSummaryText}>
                                    {mealPreferences.dislikedIngredients || 'None specified'}
                                </Text>
                            </View>
                        </ScrollView>
                        <TouchableOpacity style={styles.editPrefsButton} onPress={handleEditPreferences}>
                            <Text style={styles.editPrefsButtonText}>Edit Preferences</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.modalButton} onPress={handleConfirmAndSuggest}>
                            <Ionicons name="sparkles" size={18} color="#fff" style={{ marginRight: 8 }} />
                            <Text style={styles.modalButtonText}>Suggest Meals</Text>
                        </TouchableOpacity>
                    </>
                )}

                {suggestionModalStep === 'results' && (
                    <>
                        <Text style={styles.modalTitle}>Meal Suggestions</Text>
                        <View style={styles.rerollButtonContainer}>
                            <TouchableOpacity
                                style={styles.rerollButton}
                                onPress={handleRerollSuggestions}
                                disabled={isSuggesting}
                            >
                                <Ionicons name="dice" size={18} color="white" />
                                <Text style={styles.rerollButtonText}>Re-roll</Text>
                            </TouchableOpacity>
                        </View>
                    
                        <FlatList
                            data={mealSuggestions}
                            keyExtractor={(item) => item.id}
                            renderItem={({ item }) => {
                                const isSelected = !!selectedSuggestions[item.id];
                                return (
                                    <TouchableOpacity
                                        style={[styles.suggestionItem, isSelected && styles.suggestionItemSelected]}
                                        onPress={() => toggleSuggestionSelection(item.id)}
                                    >
                    <View style={styles.suggestionCheckbox}>{isSelected && <Text>✓</Text>}</View>
                                            <View style={{ flex: 1 }}>
                                                <Text style={styles.suggestionName}>{item.name}</Text>
                                                <Text style={styles.suggestionDescription}>{item.description}</Text>
                                        </View>
                                    </TouchableOpacity>
                                );
                            }}
                        />
                        <TouchableOpacity
                            style={[styles.modalButton, selectedCount === 0 && styles.modalButtonDisabled]}
                            onPress={handleAddSelectedMeals}
                            disabled={selectedCount === 0}
                        >
                            <Text style={styles.modalButtonText}>
                                {selectedCount > 0 ? `Add ${selectedCount} Selected Meal(s)` : 'Select a Meal'}
                            </Text>
                        </TouchableOpacity>
                    </> 
                )}
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    // Copied only the necessary styles from ListScreen
    modalBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.4)',
    },
    modalContent: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: '#fff',
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        padding: 20,
        maxHeight: '75%',
    },
    modalTitle: {
        fontSize: 22,
        fontWeight: 'bold',
        marginBottom: 20,
        textAlign: 'center',
    },
    suggestionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 15,
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 10,
        marginBottom: 10,
    },
    suggestionItemSelected: {
        borderColor: primary,
        backgroundColor: '#f0f8ff',
    },
    suggestionCheckbox: {
        width: 24,
        height: 24,
        borderWidth: 1,
        borderColor: '#999',
        borderRadius: 4,
        marginRight: 15,
        alignItems: 'center',
        justifyContent: 'center',
    },
    suggestionName: {
        fontSize: 16,
        fontWeight: '600',
    },
    suggestionDescription: {
        fontSize: 14,
        color: '#666',
        marginTop: 4,
    },
    modalButton: {
        backgroundColor: primary,
        padding: 15,
        borderRadius: 10,
        alignItems: 'center',
        marginTop: 10,
        flexDirection: 'row',
        justifyContent: 'center',
    },
    rerollButtonContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
        marginBottom: 10,
    },
    rerollButton: {
        backgroundColor: primary,
        paddingHorizontal: 20,
        paddingVertical: 8,
        borderRadius: 30,
        width: 'auto',
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
    },
    rerollButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 'bold',
        marginLeft:5
    },
    modalButtonDisabled: {
        backgroundColor: '#ccc',
    },
    modalButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 'bold',
    },
    suggestionLoadingContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        marginVertical: 40,
    },
    suggestionLoadingText: {
        marginTop: 15,
        fontSize: 16,
        color: '#666',
        fontStyle: 'italic',
    },
    prefsSummaryContainer: {
        backgroundColor: '#f7f7f7',
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
    },
    prefsSummaryTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: '#888',
        textTransform: 'uppercase',
        marginBottom: 4,
    },
    prefsSummaryText: {
        fontSize: 16,
        color: '#333',
        marginBottom: 12,
        fontStyle: 'italic',
    },
    editPrefsButton: {
        padding: 15,
        borderRadius: 10,
        alignItems: 'center',
        marginTop: 10,
        backgroundColor: '#eef2f5',
    },
    editPrefsButtonText: {
        color: primary,
        fontSize: 16,
        fontWeight: 'bold',
    },
});

