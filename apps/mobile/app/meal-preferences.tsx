import { AmbientBackground, GlassPressable as TouchableOpacity, GlassSurface } from '@/components/ui/Glass';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';
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
    accessibilityRole="checkbox"
    accessibilityState={{ checked: isSelected }}
  >
    <Ionicons name={isSelected ? 'checkmark-circle' : 'ellipse-outline'} size={23} color={isSelected ? '#FFFFFF' : '#A4B5A6'} />
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
              A few things that make a meal feel right for you. We’ll keep these in mind for every suggestion.
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
              <Text style={styles.title}>A few things to leave out?</Text>
              <Text style={styles.subtitle}>
                Tell us which ingredients you’d rather skip. We’ll leave them out of your meal suggestions.
              </Text>
              <TextInput
                style={styles.input}
                placeholder="e.g., mushrooms, cilantro, olives"
                value={dislikedIngredients}
                onChangeText={setDislikedIngredients}
                placeholderTextColor="#999"
              />
              <Text style={styles.footnote}>
                You can choose a cuisine or mood each time you ask for a meal. These preferences are your everyday starting point.
              </Text>
            </>
          );
      default:
        return null;
    }
  };

  return (
    <AmbientBackground>
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.container}
      >
        <View style={styles.header}>
            <View style={styles.navigationRow}>
              <GlassSurface style={styles.backGlass}><TouchableOpacity style={styles.backButton} onPress={() => router.back()} accessibilityLabel="Go back"><Ionicons name="chevron-back" size={21} color="#173F35" /></TouchableOpacity></GlassSurface>
              <Text style={styles.headerTitle}>MADE FOR YOU</Text>
              <Text style={styles.progressText}>{currentStep} / {TOTAL_STEPS}</Text>
            </View>
            <View style={styles.progressTrack}><View style={[styles.progressSegment, styles.progressComplete]} /><View style={[styles.progressSegment, currentStep === 2 && styles.progressComplete]} /></View>
        </View>
        {/* The Next/Finish row is pinned below this, so a step's own text field
            can end up under the keyboard with nothing beneath it to scroll up. */}
        <ScrollView
            ref={keyboard.scrollRef}
            {...keyboard.scrollProps}
            contentContainerStyle={[styles.scrollContent, { paddingBottom: 20 + keyboard.keyboardSpace }]}
            keyboardShouldPersistTaps="handled"
        >
            <Animated.View key={currentStep} entering={FadeInDown.duration(320).reduceMotion(ReduceMotion.System)}>
              <View style={styles.stepIcon}><Ionicons name={currentStep === 1 ? 'leaf-outline' : 'nutrition-outline'} size={28} color={primary} /></View>
              {renderStepContent()}
            </Animated.View>
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
              <Text style={[styles.navButtonText, styles.primaryButtonText]}>Continue</Text><Ionicons name="arrow-forward" size={18} color="#FFFFFF" />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.navButton, styles.primaryButton]}
              onPress={handleFinish}
            >
              <Text style={[styles.navButtonText, styles.primaryButtonText]}>Save preferences</Text><Ionicons name="checkmark" size={19} color="#FFFFFF" />
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: 'transparent', paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
  container: { flex: 1, paddingHorizontal: 24, paddingTop: 17, paddingBottom: 18 },
  header: { marginBottom: 28 },
  navigationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 23 },
  backGlass: { borderRadius: 19 },
  backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 10, letterSpacing: 1.5, fontWeight: '700', color: '#78857D' },
  progressText: { fontSize: 12, fontWeight: '600', color: '#78857D', width: 40, textAlign: 'right' },
  progressTrack: { flexDirection: 'row', gap: 7 },
  progressSegment: { flex: 1, height: 4, borderRadius: 3, backgroundColor: '#E0E7DC' },
  progressComplete: { backgroundColor: '#23785E' },
  footnote: { fontSize: 13, color: '#78857D', marginTop: 12, lineHeight: 21, paddingHorizontal: 2 },
  scrollContent: { paddingBottom: 20, flexGrow: 1 },
  stepIcon: { width: 60, height: 60, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#DCEDE2', marginBottom: 22 },
  title: { fontSize: 32, lineHeight: 37, fontWeight: '700', letterSpacing: -1.1, marginBottom: 13, color: '#173F35' },
  subtitle: { fontSize: 14, lineHeight: 22, color: '#78857D', marginBottom: 28 },
  tileContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: { width: '47.8%', minHeight: 102, padding: 18, borderRadius: 23, borderWidth: 1, borderColor: '#FFFFFF', backgroundColor: 'rgba(255,255,255,0.75)', justifyContent: 'space-between', gap: 14 },
  tileSelected: { backgroundColor: primary, borderColor: '#45927A' },
  tileText: { fontSize: 14, fontWeight: '600', color: '#173F35' },
  tileTextSelected: { color: '#fff', fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#E2E8DE', borderRadius: 20, padding: 18, fontSize: 15, marginBottom: 15, backgroundColor: 'rgba(255,255,255,0.8)', color: '#173F35' },
  footer: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 18, borderTopWidth: 1, borderTopColor: '#E2E8DE' },
  navButton: { paddingVertical: 17, paddingHorizontal: 22, borderRadius: 19, backgroundColor: '#E6EBE4', flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center' },
  navButtonText: { fontSize: 15, fontWeight: '600', color: '#476458' },
  primaryButton: { backgroundColor: primary },
  primaryButtonText: { color: '#fff' },
});
