// screens/MealPreferencesScreen.tsx

import { saveMealPreferences } from '@/utils/api';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

// --- DATA CONSTANTS ---
const DIETARY_NEEDS = [
  'Vegetarian', 'Vegan', 'Gluten-Free', 'Dairy-Free', 'Nut-Free', 'Pescatarian',
];
const COOKING_STYLES = [
  'Quick & Easy', 'Healthy & Light', 'Family Friendly', 'Comfort Food', 'Budget-Friendly', 'Adventurous',
];
const CUISINES = [
  'Italian', 'Mexican', 'American', 'Mediterranean', 'Indian', 'Thai', 'Japanese', 'Chinese', 'Anything!',
];
const TOTAL_STEPS = 4;

// --- REUSABLE TILE COMPONENT ---
const PreferenceTile = ({ label, isSelected, onPress }: { label: string, isSelected: boolean, onPress: () => void }) => (
  <TouchableOpacity
    style={[styles.tile, isSelected && styles.tileSelected]}
    onPress={onPress}
  >
    <Text style={[styles.tileText, isSelected && styles.tileTextSelected]}>
      {label}
    </Text>
  </TouchableOpacity>
);

// --- MAIN SCREEN COMPONENT ---
export default function MealPreferencesScreen() {
  const [currentStep, setCurrentStep] = useState(1);

  const router = useRouter();

  // State for user's selections
  const [dietaryNeeds, setDietaryNeeds] = useState<string[]>([]);
  const [cookingStyles, setCookingStyles] = useState<string[]>([]);
  const [cuisines, setCuisines] = useState<string[]>([]);
  const [dislikedIngredients, setDislikedIngredients] = useState<string[]>([]);
  const [dislikeInput, setDislikeInput] = useState('');

  const toggleSelection = (setter: React.Dispatch<React.SetStateAction<string[]>>, value: string) => {
    setter(prev =>
      prev.includes(value)
        ? prev.filter(item => item !== value)
        : [...prev, value]
    );
  };
  
  const handleAddDislike = () => {
    if (dislikeInput.trim() && !dislikedIngredients.includes(dislikeInput.trim())) {
      setDislikedIngredients(prev => [...prev, dislikeInput.trim()]);
      setDislikeInput('');
    }
  };
  
  const handleRemoveDislike = (ingredientToRemove: string) => {
      setDislikedIngredients(prev => prev.filter(ing => ing !== ingredientToRemove));
  };

  const handleNext = () => {
    if (currentStep < TOTAL_STEPS) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleFinish = async () => {
    const preferences = {
      dietaryNeeds,
      cookingStyles,
      cuisines,
      dislikedIngredients,
    };
    
    await saveMealPreferences(preferences);
    
    router.back();
  };
  
  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <>
            <Text style={styles.title}>First, any specific dietary needs?</Text>
            <Text style={styles.subtitle}>Select any that apply.</Text>
            <View style={styles.tileContainer}>
              {DIETARY_NEEDS.map(need => (
                <PreferenceTile
                  key={need}
                  label={need}
                  isSelected={dietaryNeeds.includes(need)}
                  onPress={() => toggleSelection(setDietaryNeeds, need)}
                />
              ))}
            </View>
          </>
        );
      case 2:
        return (
          <>
            <Text style={styles.title}>What's your typical cooking style?</Text>
            <Text style={styles.subtitle}>Pick a few that sound like you.</Text>
            <View style={styles.tileContainer}>
              {COOKING_STYLES.map(style => (
                <PreferenceTile
                  key={style}
                  label={style}
                  isSelected={cookingStyles.includes(style)}
                  onPress={() => toggleSelection(setCookingStyles, style)}
                />
              ))}
            </View>
          </>
        );
      case 3:
        return (
          <>
            <Text style={styles.title}>Which cuisines are you in the mood for?</Text>
            <Text style={styles.subtitle}>This helps us pick a flavor profile.</Text>
            <View style={styles.tileContainer}>
              {CUISINES.map(cuisine => (
                <PreferenceTile
                  key={cuisine}
                  label={cuisine}
                  isSelected={cuisines.includes(cuisine)}
                  onPress={() => toggleSelection(setCuisines, cuisine)}
                />
              ))}
            </View>
          </>
        );
      case 4:
          return (
            <>
              <Text style={styles.title}>Anything we should avoid?</Text>
              <Text style={styles.subtitle}>List any ingredients you dislike.</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g., mushrooms, cilantro, olives..."
                value={dislikeInput}
                onChangeText={setDislikeInput}
                onSubmitEditing={handleAddDislike}
                returnKeyType="done"
                placeholderTextColor="#999"
              />
              <View style={styles.tagContainer}>
                {dislikedIngredients.map(ing => (
                    <View key={ing} style={styles.tag}>
                        <Text style={styles.tagText}>{ing}</Text>
                        <TouchableOpacity onPress={() => handleRemoveDislike(ing)}>
                            <Text style={styles.tagRemove}>✕</Text>
                        </TouchableOpacity>
                    </View>
                ))}
              </View>
            </>
          );
      default:
        return null;
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.container}
      >
        <View style={styles.header}>
            <Text style={styles.progressText}>
                Step {currentStep} of {TOTAL_STEPS}
            </Text>
        </View>
        <ScrollView contentContainerStyle={styles.scrollContent}>
            {renderStepContent()}
        </ScrollView>
        <View style={styles.footer}>
          {currentStep > 1 && (
            <TouchableOpacity style={styles.navButton} onPress={handleBack}>
              <Text style={styles.navButtonText}>Back</Text>
            </TouchableOpacity>
          )}
          <View style={{flex: 1}} />
          {currentStep < TOTAL_STEPS ? (
            <TouchableOpacity
              style={[styles.navButton, styles.primaryButton]}
              onPress={handleNext}
            >
              <Text style={[styles.navButtonText, styles.primaryButtonText]}>Next</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.navButton, styles.primaryButton]}
              onPress={handleFinish}
            >
              <Text style={[styles.navButtonText, styles.primaryButtonText]}>Finish</Text>
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// --- STYLES ---
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#fff', paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0, },
  container: { flex: 1, padding: 20 },
  header: { alignItems: 'center', marginBottom: 20, },
  progressText: { fontSize: 16, color: '#888' },
  scrollContent: { paddingBottom: 20, flexGrow: 1 },
  title: { fontSize: 26, fontWeight: 'bold', textAlign: 'center', marginBottom: 8, color: '#222', },
  subtitle: { fontSize: 16, textAlign: 'center', color: '#666', marginBottom: 30, },
  tileContainer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', },
  tile: {
    backgroundColor: '#f0f0f0',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 20,
    margin: 6,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  tileSelected: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  tileText: {
    fontSize: 16,
    color: '#333',
  },
  tileTextSelected: {
    color: '#fff',
    fontWeight: 'bold',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 15,
  },
  tagContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 10,
  },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#e0e0e0',
    borderRadius: 15,
    paddingVertical: 6,
    paddingHorizontal: 12,
    margin: 4,
  },
  tagText: {
    fontSize: 14,
    marginRight: 8,
  },
  tagRemove: {
    fontSize: 14,
    color: '#555',
    fontWeight: 'bold',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  navButton: {
    paddingVertical: 12,
    paddingHorizontal: 30,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
  },
  navButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
  },
  primaryButton: {
    backgroundColor: '#007AFF',
  },
  primaryButtonText: {
    color: '#fff',
  },
});