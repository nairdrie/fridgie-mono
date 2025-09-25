import { Ingredient, Item, Meal, Recipe } from '@/types/types';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Keyboard, KeyboardAvoidingView, Modal, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import uuid from 'react-native-uuid';
import { getRecipe, importRecipeFromUrl, saveRecipe, uploadRecipePhoto } from '../utils/api';

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
  const [creationMode, setCreationMode] = useState<'initial' | 'automatic' | 'manual'>('initial');

  const createBlankRecipe = (): Recipe => ({
    id: uuid.v4() as string,
    name: mealForRecipe?.name || '',
    description: '',
    ingredients: [{ name: '', quantity: '' }],
    instructions: [''],
  });
  
  useEffect(() => {
    if (!isVisible || !mealForRecipe) {
      setEditingRecipe(null);
      return;
    }

    const setupRecipe = async () => {
      setIsLoading(true);
      setImportUrl('');
      
      if (mealForRecipe.recipeId) {
        setCreationMode('manual');
        try {
          const existingRecipe = await getRecipe(mealForRecipe.recipeId);
          setEditingRecipe(existingRecipe);
        } catch (e) {
          console.error("Failed to fetch recipe for editing", e);
          Alert.alert("Error", "Could not load the recipe to edit.");
          onClose();
        }
      } else {
        setCreationMode('initial');
        setEditingRecipe(createBlankRecipe());
      }
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
      // On successful import, go to the manual editing mode with the imported data
      setEditingRecipe(prev => ({ ...importedRecipe, id: prev!.id }));
      setCreationMode('manual');
    } catch (error) {
      console.error("Failed to import recipe", error);
      Alert.alert("Import Failed", "Couldn't get the recipe from that URL. Please try a different link.");
    } finally {
      setIsImporting(false);
    }
  };
  
  // ✅ 1. New handler for the back button
  const handleBackPress = () => {
    // Go back to the initial selection from any other state
    if (creationMode === 'automatic' || creationMode === 'manual') {
      setCreationMode('initial');
      // Reset to a blank slate in case of a bad import
      setEditingRecipe(createBlankRecipe());
      setImportUrl('');
    }
  };

  const handleSaveRecipe = async () => {
    // (This function remains the same as before)
    if (!editingRecipe || !mealForRecipe) return;
    if(editingRecipe.photoURL && !editingRecipe.photoURL.startsWith('http')) {
      try {
        editingRecipe.photoURL = await uploadRecipePhoto(editingRecipe.photoURL, editingRecipe.id);
      } catch(e) { console.error("Failed to upload photo", e); Alert.alert("Error", "Could not upload photo."); return; }
    }
    try {
      const recipeToSave = { ...editingRecipe, ingredients: (editingRecipe.ingredients || []).filter(i => (i.name ?? '').trim() !== ''), instructions: (editingRecipe.instructions || []).filter(i => (i ?? '').trim() !== '') };
      const savedRecipe = await saveRecipe(recipeToSave);
      const updatedMeal = { ...mealForRecipe, recipeId: savedRecipe.id, name: savedRecipe.name };
      const newItemsForRecipe = savedRecipe.ingredients.map(ing => ({ id: uuid.v4() as string, text: ing.name.trim(), quantity: ing.quantity.trim(), checked: false, listOrder: 'NEEDS-RANK', isSection: false, mealId: mealForRecipe.id }));
      onRecipeSave(updatedMeal, newItemsForRecipe);
      onClose();
    } catch (error) { console.error("Failed to save recipe", error); Alert.alert("Error", "Could not save recipe."); }
  };

  const handlePickImage = async () => {
    // (This function remains the same as before)
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { Alert.alert('Permission needed', 'Sorry, we need camera roll permissions to add a photo.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [16, 9], quality: 0.7 });
    if (!result.canceled && result.assets[0].uri) { handleRecipeFieldChange('photoURL', result.assets[0].uri); }
  };

  const handleRecipeFieldChange = (field: keyof Recipe, value: string) => setEditingRecipe(p => p ? { ...p, [field]: value } : null);
  const handleIngredientChange = (index: number, field: keyof Ingredient, value: string) => setEditingRecipe(p => { if (!p) return null; const ni = [...p.ingredients]; ni[index] = { ...ni[index], [field]: value }; return { ...p, ingredients: ni }; });
  const addIngredientField = () => setEditingRecipe(p => p ? { ...p, ingredients: [...p.ingredients, { name: '', quantity: '' }] } : null);
  const removeIngredientField = (index: number) => setEditingRecipe(p => p ? { ...p, ingredients: p.ingredients.filter((_, i) => i !== index) } : null);
  const handleInstructionChange = (index: number, value: string) => setEditingRecipe(p => { if (!p) return null; const ni = [...p.instructions]; ni[index] = value; return { ...p, instructions: ni }; });
  const addInstructionField = () => setEditingRecipe(p => p ? { ...p, instructions: [...p.instructions, ''] } : null);
  const removeInstructionField = (index: number) => setEditingRecipe(p => p ? { ...p, instructions: p.instructions.filter((_, i) => i !== index) } : null);

  const renderContent = () => {
    if (isLoading) return <ActivityIndicator style={{ marginTop: 40 }} size="large" />;
    
    if (creationMode === 'initial') {
      return (
        <View style={styles.selectionContainer}>
          <TouchableOpacity style={styles.selectionButton} onPress={() => setCreationMode('automatic')}>
            <View style={styles.iconRow}><Ionicons name="globe-outline" size={32} color={primary} /><Ionicons name="logo-tiktok" size={32} color={primary} /></View>
            <Text style={styles.selectionButtonTitle}>Automatic Import</Text>
            <Text style={styles.selectionButtonDescription}>Paste a link from a recipe website or TikTok to get started.</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.selectionButton} onPress={() => setCreationMode('manual')}>
            <Ionicons name="create-outline" size={32} color={primary} />
            <Text style={styles.selectionButtonTitle}>Manual Entry</Text>
            <Text style={styles.selectionButtonDescription}>Enter the recipe details yourself, step-by-step.</Text>
          </TouchableOpacity>
        </View>
      );
    }
    
    if (creationMode === 'automatic') {
      return (
        <View style={styles.formSectionContainer}>
          <TextInput style={styles.formInput} placeholder="Paste a recipe link..." placeholderTextColor="#999" value={importUrl} onChangeText={setImportUrl} autoCapitalize="none" keyboardType="url" />
          <TouchableOpacity style={[styles.primaryButton, isImporting && styles.disabledButton]} onPress={handleImportRecipe} disabled={isImporting}>
            {isImporting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Import</Text>}
          </TouchableOpacity>
        </View>
      );
    }
    
    if (creationMode === 'manual' && editingRecipe) {
      return (
        <>
            <View style={styles.formSectionContainer}>
              {editingRecipe.photoURL ? ( <TouchableOpacity onPress={handlePickImage}><Image source={{ uri: editingRecipe.photoURL }} style={styles.recipeImage} /><View style={styles.imageEditIcon}><Ionicons name="pencil" size={18} color="#fff" /></View></TouchableOpacity>
              ) : ( <TouchableOpacity style={[styles.recipeImage, styles.addImageButton]} onPress={handlePickImage}><Ionicons name="camera-outline" size={24} color={primary} /><Text style={styles.addImageButtonText}>Add Photo</Text></TouchableOpacity> )}
            </View>
            <View style={styles.formSectionContainer}>
              <TextInput style={styles.recipeNameInput} placeholder="Recipe Name" placeholderTextColor="#999" value={editingRecipe.name} onChangeText={(val) => handleRecipeFieldChange('name', val)} multiline />
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
      );
    }

    return null;
  };

  return (
    <Modal animationType="slide" visible={isVisible} onRequestClose={onClose} transparent={true}>
      {/* ✅ 2. New structure for a content-sized modal */}
      <View style={styles.modalOverlay}>
        <SafeAreaView style={styles.modalSafeArea}>
            <KeyboardAvoidingView style={styles.modalContentContainer} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
              <View style={styles.modalHeader}>
                {/* ✅ 3. Conditionally render the Back button */}
                {(creationMode === 'automatic' || creationMode === 'manual') && !mealForRecipe?.recipeId ? (
                  <TouchableOpacity onPress={handleBackPress} style={styles.backButton}>
                    <Ionicons name="chevron-back" size={28} color="#aaa" />
                  </TouchableOpacity>
                ) : <View style={styles.backButton} /> /* Placeholder to keep title centered */}
                
                <Text style={styles.modalTitle}>{mealForRecipe?.recipeId ? 'Edit' : 'Add'} Recipe</Text>
                
                <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                  <Ionicons name="close-circle" size={28} color="#aaa" />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.modalScrollView} contentContainerStyle={styles.modalScrollViewContent} keyboardShouldPersistTaps="handled">
                {renderContent()}

              {(creationMode === 'automatic' || creationMode === 'manual') && (
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.secondaryButton} onPress={onClose}><Text style={styles.secondaryButtonText}>Cancel</Text></TouchableOpacity>
                  <TouchableOpacity style={styles.primaryButton} onPress={handleSaveRecipe}><Text style={styles.primaryButtonText}>Save Recipe</Text></TouchableOpacity>
                </View>
              )}
              </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // ✅ 1. Align the overlay content to the bottom
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'flex-end', // Changed from 'center'
  },
  // ✅ 2. Remove top padding, as it's no longer needed for centering
  modalSafeArea: {
    width: '100%',
    maxHeight: '90%',
    // paddingTop: 40, // Removed this line
  },
  // ✅ 3. Round only the top corners for a "bottom sheet" appearance
  modalContentContainer: {
    backgroundColor: '#F7F7F7',
    borderTopLeftRadius: 20,  // Changed from borderRadius
    borderTopRightRadius: 20, // Changed from borderRadius
    overflow: 'hidden',
  },
  modalHeader: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1, 
    borderBottomColor: '#EFEFEF',
    backgroundColor: '#FFFFFF',
  },
  modalTitle: { fontSize: 22, fontWeight: 'bold', textAlign: 'center'},
  backButton: { width: 30, alignItems: 'flex-start' },
  closeButton: { width: 30, alignItems: 'flex-end' },
  modalScrollView: { maxHeight: '100%' }, // This prevents the ScrollView from growing infinitely
  modalScrollViewContent: {  },
  formSectionContainer: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 16, marginBottom: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
  formSectionTitle: { fontSize: 18, fontWeight: '600', marginBottom: 12 },
  formInput: { color: '#222222', borderWidth: 1, borderColor: '#EFEFEF', borderRadius: 8, padding: 12, fontSize: 16, marginBottom: 12 },
  recipeNameInput: { fontSize: 24, fontWeight: 'bold', marginBottom: 8, borderBottomWidth: 1, borderColor: '#EFEFEF', paddingBottom: 8, color: '#222222' },
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
  recipeImage: { width: '100%', aspectRatio: 16 / 9, borderRadius: 10, backgroundColor: '#f0f0f0', resizeMode: 'cover' },
  addImageButton: { justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: '#e0e0e0', borderStyle: 'dashed' },
  addImageButtonText: { marginTop: 8, color: primary, fontWeight: '600' },
  imageEditIcon: { position: 'absolute', bottom: 10, right: 10, backgroundColor: 'rgba(0,0,0,0.5)', padding: 8, borderRadius: 16 },
  selectionContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  selectionButton: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 24,
    width: '100%',
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 5,
    elevation: 3,
  },
  selectionButtonTitle: { fontSize: 20, fontWeight: 'bold', color: primary, marginTop: 12, marginBottom: 6 },
  selectionButtonDescription: { fontSize: 14, color: '#666', textAlign: 'center' },
  iconRow: { flexDirection: 'row', gap: 16 },
});