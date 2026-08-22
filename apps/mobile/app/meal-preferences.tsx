// screens/MealPreferencesScreen.tsx

import { useKeyboardAwareScroll } from '@/hooks/useKeyboardAwareScroll';
import { getMealPreferences, saveMealPreferences } from '@/utils/api';
import { primary } from '@/utils/styles';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  Alert,
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

// Two steps, not four. Cuisine and cooking style used to be asked here and then
// applied to every suggestion forever, which is the wrong shape for them — what
// you feel like eating is a property of the evening, not of you. They are now
// offered as hints at suggestion time. What's left is the pair that genuinely
// doesn't change between Tuesday and Saturday.
const TOTAL_STEPS = 2;

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
  const keyboard = useKeyboardAwareScroll();

  // State for user's selections
  const [dietaryNeeds, setDietaryNeeds] = useState<string[]>([]);
  const [dislikedIngredients, setDislikedIngredients] = useState<string>('');

   useEffect(() => {
    const loadPreferences = async () => {
      try {
        const prefs = await getMealPreferences();
        if (prefs) {
          setDietaryNeeds(prefs.dietaryNeeds || []);
          setDislikedIngredients(prefs.dislikedIngredients || '');
        }
      } catch (error) {
        // This is expected for new users, so we can ignore the error.
        console.log("No existing preferences found. Starting fresh.");
      }
    };

    loadPreferences();
  }, []);

  const toggleSelection = (setter: React.Dispatch<React.SetStateAction<string[]>>, value: string) => {
    setter(prev =>
      prev.includes(value)
        ? prev.filter(item => item !== value)
        : [...prev, value]
    );
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
    // Only these two. A previously-saved `cuisines`/`cookingStyles` is left on
    // the document rather than cleared — the suggest route already ignores it,
    // and rewriting other people's data to prove a point isn't worth a
    // migration.
    const preferences = {
      dietaryNeeds,
      dislikedIngredients,
    };

    try {
      await saveMealPreferences(preferences);
      router.back();
    } catch (error) {
      console.error("Failed to save meal preferences:", error);
      Alert.alert("Error", "Could not save your preferences. Please try again.");
    }
  };
  
  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <>
            <Text style={styles.title}>Any dietary needs?</Text>
            <Text style={styles.subtitle}>
              These apply to every suggestion, every time. You can switch one off
              for a single suggestion later — handy when you&apos;re cooking for
              other people.
            </Text>
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
              <Text style={styles.title}>Anything you never want to see?</Text>
              <Text style={styles.subtitle}>
                Ingredients to keep out of every suggestion.
              </Text>
              <TextInput
                style={styles.input}
                placeholder="e.g., mushrooms, cilantro, olives"
                value={dislikedIngredients}
                onChangeText={setDislikedIngredients}
                placeholderTextColor="#999"
              />
              <Text style={styles.footnote}>
                Not sure what you feel like eating? That part isn&apos;t here —
                you&apos;ll pick a cuisine or a mood when you ask for suggestions.
              </Text>
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
            <Text style={styles.headerTitle}>Your everyday preferences</Text>
            {/* This screen is reached by tapping "Suggest Meal", so without
                saying so it reads as a form about tonight's dinner — people
                filled in a craving and then wondered why every future
                suggestion was Thai. */}
            <Text style={styles.headerSubtitle}>
                Saved once and applied to every suggestion — not just today&apos;s.
            </Text>
            <Text style={styles.progressText}>
                Step {currentStep} of {TOTAL_STEPS}
            </Text>
        </View>
        {/* The Next/Finish row is pinned below this, so a step's own text field
            can end up under the keyboard with nothing beneath it to scroll up. */}
        <ScrollView
            ref={keyboard.scrollRef}
            {...keyboard.scrollProps}
            contentContainerStyle={[styles.scrollContent, { paddingBottom: 20 + keyboard.keyboardSpace }]}
            keyboardShouldPersistTaps="handled"
        >
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
  headerTitle: { fontSize: 15, fontWeight: '700', color: '#333' },
  headerSubtitle: { fontSize: 13, color: '#888', textAlign: 'center', marginTop: 2, marginBottom: 8, paddingHorizontal: 20 },
  progressText: { fontSize: 13, color: '#aaa' },
  footnote: { fontSize: 14, color: '#888', textAlign: 'center', marginTop: 8, lineHeight: 20 },
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
    backgroundColor: primary,
    borderColor: primary,
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
    backgroundColor: primary,
  },
  primaryButtonText: {
    color: '#fff',
  },
});