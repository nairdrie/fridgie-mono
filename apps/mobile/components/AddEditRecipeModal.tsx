import { Ingredient, Item, Meal, Recipe } from '@/types/types';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Keyboard, KeyboardAvoidingView, Modal, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import uuid from 'react-native-uuid';
import { getRecipe, importRecipeFromUrl, saveRecipe, uploadRecipePhoto } from '../utils/api';

// TODO: import from tiktok. have this work as a share option on apps so we dont have to use the link

interface AddEditRecipeModalProps {
  isVisible: boolean;
  onClose: () => void;
  mealForRecipe: Meal | null;
  onRecipeSave: (updatedMeal: Meal, newItems: Item[]) => void;
}

export default function AddEditRecipeModal({ isVisible, onClose, mealForRecipe, onRecipeSave }: AddEditRecipeModalProps) {
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);
  const [importUrl, setImportUrl] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!isVisible || !mealForRecipe) {
      setEditingRecipe(null);
      return;
    }

    const setupRecipe = async () => {
      setIsLoading(true);
      // If the meal already has a recipe, fetch it for editing.
      if (mealForRecipe.recipeId) {
        try {
          const existingRecipe = await getRecipe(mealForRecipe.recipeId);
          setEditingRecipe(existingRecipe);
        } catch (e) {
          console.error("Failed to fetch recipe for editing", e);
          Alert.alert("Error", "Could not load the recipe to edit.");
          onClose();
        }
      } else {
        // Otherwise, create a new blank recipe for adding.
        const blankRecipe: Recipe = {
          id: uuid.v4() as string,
          name: mealForRecipe.name || '',
          description: '',
          ingredients: [{ name: '', quantity: '' }],
          instructions: [''],
        };
        setEditingRecipe(blankRecipe);
      }
      setImportUrl('');
      setIsLoading(false);
    };

    setupRecipe();
  }, [isVisible, mealForRecipe]);

  const handleImportRecipe = async () => {
    if (!importUrl) return;
    Keyboard.dismiss();
    setIsImporting(true);
    try {
      const importedRecipe = await importRecipeFromUrl(importUrl);
      setEditingRecipe(prev => ({ ...importedRecipe, id: prev!.id }));
    } catch (error) {
      console.error("Failed to import recipe", error);
      Alert.alert("Import Failed", "Couldn't get the recipe from that URL. Please try again.");
    } finally {
      setIsImporting(false);
    }
  };

  const handleSaveRecipe = async () => {
    if (!editingRecipe || !mealForRecipe) return;
  
    if(editingRecipe.photoURL) {
      try {
        editingRecipe.photoURL = await uploadRecipePhoto(editingRecipe.photoURL, editingRecipe.id);
      } catch(e) {
        console.error("Failed to save recipe", e);
        Alert.alert("Error", "Could not save the recipe.");
        return;
      }
    }
    try {
      const recipeToSave: Recipe = {
        ...editingRecipe,
        ingredients: (editingRecipe.ingredients || []).filter(i => (i.name ?? '').trim() !== ''),
        instructions: (editingRecipe.instructions || []).filter(i => (i ?? '').trim() !== ''),
      };

      const savedRecipe = await saveRecipe(recipeToSave);
      const updatedMeal = { ...mealForRecipe, recipeId: savedRecipe.id, name: savedRecipe.name };
      
      const newItemsForRecipe: Item[] = savedRecipe.ingredients.map(ingredient => ({
        id: uuid.v4() as string,
        text: ingredient.name.trim(),
        quantity: ingredient.quantity.trim(),
        checked: false,
        listOrder: 'NEEDS-RANK',
        isSection: false,
        mealId: mealForRecipe.id,
      }));
  
      onRecipeSave(updatedMeal, newItemsForRecipe);
      onClose();
    } catch (error) {
      console.error("Failed to save recipe", error);
      Alert.alert("Error", "Could not save the recipe.");
    }
  };

  const handlePickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
        Alert.alert('Permission needed', 'Sorry, we need camera roll permissions to add a photo.');
        return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [16, 9],
        quality: 0.7,
    });

    if (!result.canceled && result.assets[0].uri) {
        // Reuse the existing handler to update the recipe state
        handleRecipeFieldChange('photoURL', result.assets[0].uri);
    }
  };

  const handleRecipeFieldChange = (field: keyof Recipe, value: string) => setEditingRecipe(p => p ? { ...p, [field]: value } : null);
  const handleIngredientChange = (index: number, field: keyof Ingredient, value: string) => {
    setEditingRecipe(p => {
      if (!p) return null;
      const newIngredients = [...p.ingredients];
      newIngredients[index] = { ...newIngredients[index], [field]: value };
      return { ...p, ingredients: newIngredients };
    });
  };
  const addIngredientField = () => setEditingRecipe(p => p ? { ...p, ingredients: [...p.ingredients, { name: '', quantity: '' }] } : null);
  const removeIngredientField = (index: number) => setEditingRecipe(p => p ? { ...p, ingredients: p.ingredients.filter((_, i) => i !== index) } : null);
  const handleInstructionChange = (index: number, value: string) => {
    setEditingRecipe(p => {
      if (!p) return null;
      const newInstructions = [...p.instructions];
      newInstructions[index] = value;
      return { ...p, instructions: newInstructions };
    });
  };
  const addInstructionField = () => setEditingRecipe(p => p ? { ...p, instructions: [...p.instructions, ''] } : null);
  const removeInstructionField = (index: number) => setEditingRecipe(p => p ? { ...p, instructions: p.instructions.filter((_, i) => i !== index) } : null);
  
  return (
    <Modal animationType="slide" visible={isVisible} onRequestClose={onClose}>
      <SafeAreaView style={styles.modalContainer}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{mealForRecipe?.recipeId ? 'Edit' : 'Add'} Recipe</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close-circle" size={28} color="#aaa" /></TouchableOpacity>
          </View>
          {isLoading ? <ActivityIndicator style={{marginTop: 40}} size="large" /> : (
            <ScrollView style={styles.modalScrollView} contentContainerStyle={styles.modalScrollViewContent} keyboardShouldPersistTaps="handled">
                <View style={styles.formSectionContainer}>
                    <TextInput style={styles.formInput} placeholder="Paste a recipe link..." placeholderTextColor="#999" value={importUrl} onChangeText={setImportUrl} autoCapitalize="none" keyboardType="url" />
                    <TouchableOpacity style={[styles.primaryButton, isImporting && styles.disabledButton]} onPress={handleImportRecipe} disabled={isImporting}>
                        {isImporting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Import</Text>}
                    </TouchableOpacity>
                </View>
                {editingRecipe && (
                <>
                    {/* --- NEW PHOTO SECTION --- */}
                      <View style={styles.formSectionContainer}>
                          {editingRecipe.photoURL ? (
                              <TouchableOpacity onPress={handlePickImage}>
                                  <Image source={{ uri: editingRecipe.photoURL }} style={styles.recipeImage} />
                                  <View style={styles.imageEditIcon}>
                                      <Ionicons name="pencil" size={18} color="#fff" />
                                  </View>
                              </TouchableOpacity>
                          ) : (
                              <TouchableOpacity style={[styles.recipeImage, styles.addImageButton]} onPress={handlePickImage}>
                                  <Ionicons name="camera-outline" size={24} color={primary} />
                                  <Text style={styles.addImageButtonText}>Add Photo</Text>
                              </TouchableOpacity>
                          )}
                      </View>
                    {/* --- END PHOTO SECTION --- */}
                    <View style={styles.formSectionContainer}>
                        <TextInput style={styles.recipeNameInput} placeholder="Recipe Name" placeholderTextColor="#999" value={editingRecipe.name} onChangeText={(val) => handleRecipeFieldChange('name', val)} />
                        <TextInput style={[styles.formInput, styles.descriptionInput]} placeholder="A short, tasty description..." placeholderTextColor="#999" value={editingRecipe.description} onChangeText={(val) => handleRecipeFieldChange('description', val)} multiline />
                    </View>
                    <View style={styles.formSectionContainer}>
                        <Text style={styles.formSectionTitle}>Ingredients</Text>
                        {editingRecipe.ingredients.map((ing, index) => (
                        <View key={`ing-${index}`} style={styles.formRow}><TextInput style={[styles.formInput, styles.quantityInput]} placeholder="1 cup" placeholderTextColor="#999" value={ing.quantity} onChangeText={(val) => handleIngredientChange(index, 'quantity', val)} /><TextInput style={[styles.formInput, styles.nameInput]} placeholder="Flour" placeholderTextColor="#999" value={ing.name} onChangeText={(val) => handleIngredientChange(index, 'name', val)} /><TouchableOpacity onPress={() => removeIngredientField(index)} style={styles.deleteRowButton}><Ionicons name="remove-circle-outline" size={24} color="#EF4444" /></TouchableOpacity></View>
                        ))}
                        <TouchableOpacity style={styles.addFieldButton} onPress={addIngredientField}><Ionicons name="add" size={20} color={primary} /><Text style={styles.addFieldButtonText}>Add Ingredient</Text></TouchableOpacity>
                    </View>
                    <View style={styles.formSectionContainer}>
                        <Text style={styles.formSectionTitle}>Instructions</Text>
                        {editingRecipe.instructions.map((inst, index) => (
                        <View key={`inst-${index}`} style={styles.formRow}><Text style={styles.stepNumber}>{index + 1}.</Text><TextInput style={[styles.formInput, styles.nameInput]} placeholder="Mix the things..." placeholderTextColor="#999" value={inst} onChangeText={(val) => handleInstructionChange(index, val)} multiline /><TouchableOpacity onPress={() => removeInstructionField(index)} style={styles.deleteRowButton}><Ionicons name="remove-circle-outline" size={24} color="#EF4444" /></TouchableOpacity></View>
                        ))}
                        <TouchableOpacity style={styles.addFieldButton} onPress={addInstructionField}><Ionicons name="add" size={20} color={primary} /><Text style={styles.addFieldButtonText}>Add Step</Text></TouchableOpacity>
                    </View>
                </>
                )}
            </ScrollView>
          )}

          <View style={styles.modalFooter}>
            <TouchableOpacity style={styles.secondaryButton} onPress={onClose}><Text style={styles.secondaryButtonText}>Cancel</Text></TouchableOpacity>
            <TouchableOpacity style={styles.primaryButton} onPress={handleSaveRecipe}><Text style={styles.primaryButtonText}>Save Recipe</Text></TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
// (Styles are the same as before)
const styles = StyleSheet.create({
    modalContainer: { flex: 1, backgroundColor: '#F7F7F7' },
    modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#EFEFEF' },
    modalTitle: { fontSize: 22, fontWeight: 'bold', flex: 1, textAlign: 'center', marginLeft: 30 },
    modalScrollView: { flex: 1 },
    modalScrollViewContent: { padding: 16, paddingBottom: 100 },
    formSectionContainer: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 16, marginBottom: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
    formSectionTitle: { fontSize: 18, fontWeight: '600', marginBottom: 12 },
    formInput: { color: '#222222', borderWidth: 1, borderColor: '#EFEFEF', borderRadius: 8, padding: 12, fontSize: 16, marginBottom: 12 },
    recipeNameInput: { fontSize: 24, fontWeight: 'bold', marginBottom: 8, borderBottomWidth: 1, borderColor: '#EFEFEF', paddingBottom: 8 },
    descriptionInput: { minHeight: 80, textAlignVertical: 'top' },
    formRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
    quantityInput: { flex: 0.3, marginRight: 8 },
    nameInput: { flex: 1 },
    stepNumber: { marginRight: 8, fontSize: 16, color: '#888' },
    deleteRowButton: { padding: 4, marginLeft: 8 },
    addFieldButton: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', paddingVertical: 8 },
    addFieldButtonText: { color: primary, fontSize: 16, fontWeight: '600', marginLeft: 4 },
    modalFooter: { flexDirection: 'row', justifyContent: 'space-between', padding: 16, borderTopWidth: 1, borderTopColor: '#EFEFEF', backgroundColor: '#FFFFFF' },
    primaryButton: { backgroundColor: primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center', flex: 1, justifyContent: 'center', minHeight: 50 },
    primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
    secondaryButton: { backgroundColor: '#EFEFEF', paddingVertical: 14, borderRadius: 12, alignItems: 'center', flex: 1, marginRight: 10 },
    secondaryButtonText: { color: '#333', fontSize: 16, fontWeight: 'bold' },
    disabledButton: { opacity: 0.6 },
    recipeImage: {
        width: '100%',
        aspectRatio: 16 / 9,
        borderRadius: 10,
        backgroundColor: '#f0f0f0',
        resizeMode: 'cover',
    },
    addImageButton: {
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 2,
        borderColor: '#e0e0e0',
        borderStyle: 'dashed',
    },
    addImageButtonText: {
        marginTop: 8,
        color: primary,
        fontWeight: '600',
    },
    imageEditIcon: {
        position: 'absolute',
        bottom: 10,
        right: 10,
        backgroundColor: 'rgba(0,0,0,0.5)',
        padding: 8,
        borderRadius: 16,
    },
});
