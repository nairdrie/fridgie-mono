import { Recipe } from '@/types/types';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { getRecipe } from '../utils/api'; // Adjust path if needed

interface ViewRecipeModalProps {
  isVisible: boolean;
  onClose: () => void;
  recipeId: string | null;
  onEdit: (recipe: Recipe) => void; // New prop to handle the edit action
}

export default function ViewRecipeModal({ isVisible, onClose, recipeId, onEdit }: ViewRecipeModalProps) {
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [isFetching, setIsFetching] = useState(false);

  useEffect(() => {
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
  }, [recipeId, isVisible]);

  const handleEditPress = () => {
    if (recipe) {
      onEdit(recipe);
    }
  };

  return (
    <Modal
      animationType="slide"
      transparent={true}
      visible={isVisible}
      onRequestClose={onClose}
    >
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={[styles.modalContent, { maxHeight: '85%' }]}>
        {isFetching && (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator size="large" />
          </View>
        )}
        {recipe && (
          <FlatList
            ListHeaderComponent={
              <>
                <Text style={styles.recipeTitle}>{recipe.name}</Text>
                <Text style={styles.recipeDescription}>{recipe.description}</Text>
                <Text style={styles.recipeSectionTitle}>Ingredients</Text>
                {recipe.ingredients.map((ing, index) => (
                  <Text key={index} style={styles.recipeIngredient}>
                    • {ing.quantity} {ing.name}
                  </Text>
                ))}
                <Text style={styles.recipeSectionTitle}>Instructions</Text>
              </>
            }
            data={recipe.instructions}
            keyExtractor={(_, index) => `instr-${index}`}
            renderItem={({ item, index }) => (
              <Text style={styles.recipeInstruction}>
                {index + 1}. {item}
              </Text>
            )}
            ListFooterComponent={
              // New footer with both Edit and Close buttons
              <View style={styles.footerButtonContainer}>
                <TouchableOpacity style={styles.secondaryButton} onPress={onClose}>
                  <Text style={styles.secondaryButtonText}>Close</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.primaryButton} onPress={handleEditPress}>
                  <Text style={styles.primaryButtonText}>Edit</Text>
                </TouchableOpacity>
              </View>
            }
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
    modalContent: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '85%' },
    recipeTitle: { fontSize: 24, fontWeight: 'bold', marginBottom: 10 },
    recipeDescription: { fontSize: 16, color: '#555', marginBottom: 20, fontStyle: 'italic' },
    recipeSectionTitle: { fontSize: 20, fontWeight: '700', marginTop: 15, marginBottom: 10, borderBottomWidth: 1, borderBottomColor: '#eee', paddingBottom: 5 },
    recipeIngredient: { fontSize: 16, lineHeight: 24, marginLeft: 10 },
    recipeInstruction: { fontSize: 16, lineHeight: 26, marginBottom: 10 },
    footerButtonContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 20,
    },
    primaryButton: {
        backgroundColor: '#007AFF',
        paddingVertical: 14,
        borderRadius: 12,
        alignItems: 'center',
        flex: 1,
        marginLeft: 5,
    },
    primaryButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 'bold',
    },
    secondaryButton: {
        backgroundColor: '#EFEFEF',
        paddingVertical: 14,
        borderRadius: 12,
        alignItems: 'center',
        flex: 1,
        marginRight: 5,
    },
    secondaryButtonText: {
        color: '#333',
        fontSize: 16,
        fontWeight: 'bold',
    },
});
