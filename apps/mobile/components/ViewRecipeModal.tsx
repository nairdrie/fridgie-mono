import { Recipe } from '@/types/types';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { addUserCookbookRecipe, getRecipe, removeUserCookbookRecipe } from '../utils/api';

interface ViewRecipeModalProps {
  isVisible: boolean;
  onClose: () => void;
  recipeId: string | null;
  onEdit: (recipe: Recipe) => void;
  isInCookbook: boolean;
  onCookbookUpdate: () => void;
}

// TODO: add to meal plan beside add to cookbook (from explore esp.)
// TODO: remove edit button if not owner 
// TODO: ensure forking is working. (if I add to meal plan or cookbook, we dont need to. unless i want to edit)
// TODO: author, likes, comments 
// TODO: report recipe (for image or inappropriate content)


export default function ViewRecipeModal({ isVisible, onClose, recipeId, onEdit, isInCookbook, onCookbookUpdate }: ViewRecipeModalProps) {
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [isCurrentlyInCookbook, setIsCurrentlyInCookbook] = useState(isInCookbook);
  const [isToggling, setIsToggling] = useState(false);
  // [NEW] State to manage the two-step removal confirmation
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);

  useEffect(() => {
    if (isVisible) {
      setIsCurrentlyInCookbook(isInCookbook);
    } else {
      // Reset confirmation state when modal becomes invisible
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

  // The core API logic remains the same
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
      setIsCurrentlyInCookbook(originalStatus); // Rollback on error
      Alert.alert("Error", "Could not update your cookbook.");
    } finally {
      setIsToggling(false);
    }
  };

  // [NEW] Wrapper function to handle the button's logic flow
  const handleCookbookButtonPress = () => {
    if (isCurrentlyInCookbook) {
      if (isConfirmingRemove) {
        // This is the second click: confirm removal
        handleToggleCookbook();
        setIsConfirmingRemove(false);
      } else {
        // This is the first click: enter confirmation mode
        setIsConfirmingRemove(true);
      }
    } else {
      // If not in cookbook, add it in one step
      handleToggleCookbook();
    }
  };

  // [NEW] Wrapper for onClose to ensure confirmation state is reset
  const handleClose = () => {
    setIsConfirmingRemove(false);
    onClose();
  };

  return (
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

            {isFetching && ( <View style={styles.loaderContainer}><ActivityIndicator size="large" /></View> )}

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
                          <TouchableOpacity style={styles.editButton} onPress={handleEditPress}>
                            <Ionicons name="pencil" size={20} color="#fff" />
                          </TouchableOpacity>
                        </View>
                        <Text style={styles.recipeDescription}>{recipe.description}</Text>
                        <Text style={styles.recipeSectionTitle}>Ingredients</Text>
                        {recipe.ingredients.map((ing, index) => (
                          <Text key={index} style={styles.recipeIngredient}>
                            • {ing.quantity} {ing.name}
                          </Text>
                        ))}
                        <Text style={styles.recipeSectionTitle}>Instructions</Text>
                      </View>
                    </>
                  }
                  data={recipe.instructions}
                  keyExtractor={(_, index) => `instr-${index}`}
                  renderItem={({ item, index }) => (
                    <View style={styles.bodyContainer}>
                        <Text style={styles.recipeInstruction}>
                            {index + 1}. {item}
                        </Text>
                    </View>
                  )}
                  showsVerticalScrollIndicator={false}
                />
                
                <View style={styles.footer}>
                  <TouchableOpacity 
                    style={[styles.primaryButton, isConfirmingRemove && styles.removeButton]} 
                    onPress={handleCookbookButtonPress} 
                    disabled={isToggling}
                  >
                    {isToggling ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <>
                        {/* [REVISED] Icon and Text now depend on the confirmation state */}
                        <Ionicons 
                          name={isConfirmingRemove ? "trash-outline" : (isCurrentlyInCookbook ? "bookmark" : "bookmark-outline")} 
                          size={20} 
                          color="#fff" 
                        />
                        <Text style={styles.primaryButtonText}>
                          {isConfirmingRemove ? "Remove from Cookbook?" : (isCurrentlyInCookbook ? "In Your Cookbook" : "Add to Cookbook")}
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
    editButton: {
        width: 44, height: 44, borderRadius: 22, backgroundColor: primary,
        justifyContent: 'center', alignItems: 'center',
        shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2, shadowRadius: 3, elevation: 4,
    },
    recipeDescription: { fontSize: 16, color: '#555', marginBottom: 20, fontStyle: 'italic' },
    recipeSectionTitle: { fontSize: 20, fontWeight: '700', marginTop: 15, marginBottom: 10, borderBottomWidth: 1, borderBottomColor: '#eee', paddingBottom: 5 },
    recipeIngredient: { fontSize: 16, lineHeight: 24, marginLeft: 10 },
    recipeInstruction: { fontSize: 16, lineHeight: 26, marginBottom: 10 },
    footer: { padding: 20, borderTopWidth: 1, borderTopColor: '#f0f0f0', backgroundColor: '#fff' },
    primaryButton: { backgroundColor: primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' },
    primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold', marginLeft: 8 },
    removeButton: {
        backgroundColor: '#c94444',
    },
});