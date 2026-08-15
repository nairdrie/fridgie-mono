// components/ViewRecipeModal.tsx
import { useAuth } from '@/context/AuthContext';
import { Recipe } from '@/types/types';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { addUserCookbookRecipe, getRecipe, removeUserCookbookRecipe } from '../utils/api';
import AddToMealPlanModal from './AddToMealPlanModal'; // Import the new component

interface ViewRecipeModalProps {
    isVisible: boolean;
    onClose: () => void;
    recipeId: string | null;
    onEdit: (recipe: Recipe) => void;
    isInCookbook: boolean;
    onCookbookUpdate: () => void;
}

// TODO: ensure forking is working. (if I add to meal plan or cookbook, we dont need to. unless i want to edit)
// TODO: author, likes, comments 
// TODO: report recipe (for image or inappropriate content)

export default function ViewRecipeModal({ isVisible, onClose, recipeId, onEdit, isInCookbook, onCookbookUpdate }: ViewRecipeModalProps) {
    const [recipe, setRecipe] = useState<Recipe | null>(null);
    const [isFetching, setIsFetching] = useState(false);
    const [isCurrentlyInCookbook, setIsCurrentlyInCookbook] = useState(isInCookbook);
    const [isToggling, setIsToggling] = useState(false);
    const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);

    const { user } = useAuth();

    // [NEW] State for the meal plan modal
    const [isMealPlanModalVisible, setIsMealPlanModalVisible] = useState(false);

    useEffect(() => {
        if (isVisible) {
            setIsCurrentlyInCookbook(isInCookbook);
        } else {
            setIsConfirmingRemove(false);
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

    const handleEditPress = () => {
        if (recipe) {
            onEdit(recipe);
        }
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
                                                    { recipe.authorUid == user?.uid &&
                                                        <TouchableOpacity style={styles.editButton} onPress={handleEditPress}>
                                                          <Ionicons name="pencil" size={20} color="#fff" />
                                                      </TouchableOpacity>
                                                    }
                                                </View>
                                                { recipe.authorName && 
                                                  <Text style={styles.recipeAuthor}>{recipe.authorName}</Text>
                                                }
                                                
                                                <Text style={styles.recipeDescription}>{recipe.description}</Text>
                                                <Text style={styles.recipeSectionTitle}>Ingredients</Text>
                                                {recipe.ingredients.map((ing, index) => (
                                                    <Text key={index} style={styles.recipeIngredient}>• {ing.quantity} {ing.name}</Text>
                                                ))}
                                                <Text style={styles.recipeSectionTitle}>Instructions</Text>
                                            </View>
                                        </>
                                    }
                                    data={recipe.instructions}
                                    keyExtractor={(_, index) => `instr-${index}`}
                                    renderItem={({ item, index }) => (
                                        <View style={styles.bodyContainer}>
                                            <Text style={styles.recipeInstruction}>{index + 1}. {item}</Text>
                                        </View>
                                    )}
                                    showsVerticalScrollIndicator={false}
                                />

                                <View style={styles.footer}>
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
    titleContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 20, marginBottom: 10 },
    recipeTitle: { fontSize: 24, fontWeight: 'bold', flex: 1, marginRight: 10 },
    recipeAuthor: {
      color: primary,
      fontSize: 18,
      marginBottom: 10
    },
    editButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: primary, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 3, elevation: 4 },
    recipeDescription: { fontSize: 16, color: '#555', marginBottom: 20, fontStyle: 'italic' },
    recipeSectionTitle: { fontSize: 20, fontWeight: '700', marginTop: 15, marginBottom: 10, borderBottomWidth: 1, borderBottomColor: '#eee', paddingBottom: 5 },
    recipeIngredient: { fontSize: 16, lineHeight: 24, marginLeft: 10 },
    recipeInstruction: { fontSize: 16, lineHeight: 26, marginBottom: 10 },
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