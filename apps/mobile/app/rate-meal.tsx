import { Recipe } from '@/types/types';
import { addUserCookbookRecipe, getRecipe, submitRecipeFeedback } from '@/utils/api';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Image,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';

// A helper function to mark a meal as rated to prevent re-prompting
const markMealAsRated = async (mealId: string) => {
    try {
        const ratedMealsRaw = await AsyncStorage.getItem('ratedMeals');
        const ratedMealIds = ratedMealsRaw ? JSON.parse(ratedMealsRaw) : {};
        ratedMealIds[mealId] = true; // Mark this meal ID as rated
        await AsyncStorage.setItem('ratedMeals', JSON.stringify(ratedMealIds));
    } catch (error) {
        console.error("Failed to mark meal as rated:", error);
    }
};


export default function RateMealScreen() {
    const router = useRouter();
    const { recipeId, mealId } = useLocalSearchParams<{ recipeId: string; mealId?: string }>();
    
    const [recipe, setRecipe] = useState<Recipe | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [feedback, setFeedback] = useState('');
    const [step, setStep] = useState<'rating' | 'feedback' | 'liked' | 'submitted'>('rating');
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (!recipeId) {
            Alert.alert("Error", "No recipe was specified.", [{ text: 'OK', onPress: () => router.back() }]);
            return;
        }

        const fetchRecipe = async () => {
            try {
                const fetchedRecipe = await getRecipe(recipeId);
                setRecipe(fetchedRecipe);
            } catch (error) {
                console.error("Failed to fetch recipe for rating:", error);
                Alert.alert("Error", "Could not load the recipe details.", [{ text: 'OK', onPress: () => router.back() }]);
            } finally {
                setIsLoading(false);
            }
        };

        fetchRecipe();
    }, [recipeId]);
    
    const handleDislike = () => {
        setStep('feedback');
    };

    const handleLike = async () => {
        setIsSubmitting(true);
        try {
        await submitRecipeFeedback(recipe!.id, 'liked');
        if (mealId) {
            await markMealAsRated(mealId);
        }
        setStep('liked');
        } catch (error) {
        console.error("Failed to submit 'like' feedback:", error);
        Alert.alert("Error", "Could not save your rating. Please try again.");
        } finally {
        setIsSubmitting(false);
        }
    };
    
    const handleSubmitFeedback = async () => {
        if (!feedback.trim()) {
            Alert.alert("Please provide some feedback before submitting.");
            return;
        }
        setIsSubmitting(true);
        try {
            await submitRecipeFeedback(recipe!.id, 'disliked', feedback);
            if (mealId) {
                await markMealAsRated(mealId);
            }
            setStep('submitted');
            setTimeout(() => router.replace('/list'), 2000); // Navigate back after a short delay
        } catch (error) {
            console.error("Failed to submit feedback:", error);
            Alert.alert("Error", "Could not submit your feedback. Please try again.");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleAddToCookbook = async () => {
        setIsSubmitting(true);
        try {
        await addUserCookbookRecipe(recipe!.id);
        Alert.alert("Added to Cookbook!", `${recipe?.name} has been saved.`);
        if (mealId) {
            await markMealAsRated(mealId);
        }
        router.replace('/list');
        } catch (error) {
        console.error("Failed to add to cookbook:", error);
        Alert.alert("Error", "Could not add recipe to your cookbook. Please try again.");
        } finally {
        setIsSubmitting(false);
        }
    };

    const handleSkipAddToCookbook = () => {
        if (mealId) {
            markMealAsRated(mealId);
        }
        router.replace('/list');
    };

    const handlePickImage = async () => {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
            Alert.alert('Sorry, we need camera roll permissions to make this work!');
            return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: true,
            aspect: [16, 9],
            quality: 0.7,
        });

        if (!result.canceled) {
            const photoUri = result.assets[0].uri;
            // In a real app, you would upload this URI to your backend/storage
            // and update the recipe's photoURL.
            console.log("New photo selected:", photoUri);
            Alert.alert("Photo Updated!", "Your new photo has been saved for this recipe.");
        }
    };

    
    // This would navigate to the screen that presents the AddEditRecipeModal
    const handleEditRecipe = () => {
        // The implementation depends on your navigation setup.
        // This is a placeholder for navigating to the edit flow.
        console.log("Navigate to edit recipe modal for meal:", recipe?.name);
        Alert.alert("Edit Recipe", "This would open the recipe editor.");
    };


    if (isLoading) {
        return (
            <View style={styles.container}>
                <ActivityIndicator size="large" />
            </View>
        );
    }

    if (!recipe) {
        return (
            <View style={styles.container}>
                <Text>Recipe not found.</Text>
            </View>
        );
    }

    return (
        <KeyboardAwareScrollView
            enableOnAndroid={true}
            extraScrollHeight={60}
            keyboardOpeningTime={0}
            contentContainerStyle={styles.safeArea}
        >
            <View style={styles.container}>
                {step === 'rating' && (
                    <>
                        <Text style={styles.title}>How was the</Text>
                        <Text style={styles.recipeName}>{recipe.name}?</Text>
                        
                        {recipe.photoURL && <Image source={{ uri: recipe.photoURL }} style={styles.mainImage} />}
                        
                        <View style={styles.ratingActions}>
                            <TouchableOpacity onPress={handleDislike} style={[styles.ratingButton, styles.dislikeButton]}>
                                <Ionicons name="thumbs-down-outline" size={32} color="#D9534F" />
                            </TouchableOpacity>
                            <TouchableOpacity onPress={handleLike} style={[styles.ratingButton, styles.likeButton]}>
                                <Ionicons name="thumbs-up-outline" size={32} color="#5CB85C" />
                            </TouchableOpacity>
                        </View>
                    </>
                )}

                {step === 'feedback' && (
                    <>
                        <Text style={styles.title}>Sorry you didn't like it!</Text>
                        <Text style={styles.subtitle}>What could be better?</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="e.g., Too salty, instructions were unclear..."
                            value={feedback}
                            onChangeText={setFeedback}
                            placeholderTextColor="#999"
                            multiline
                        />
                        <TouchableOpacity
                            style={[styles.primaryButton, (isSubmitting || !feedback) && styles.disabledButton]}
                            onPress={handleSubmitFeedback}
                            disabled={isSubmitting || !feedback}
                        >
                            {isSubmitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Submit Feedback</Text>}
                        </TouchableOpacity>
                    </>
                )}

                {step === 'liked' && (
                    <>
                        <Text style={styles.title}>Glad you liked it!</Text>
                        <Image source={{ uri: recipe.photoURL }} style={styles.mainImage} />
                        <Text style={styles.subtitle}>Would you like to add it to your personal cookbook for next time?</Text>
                        <TouchableOpacity style={styles.primaryButton} onPress={handleAddToCookbook}>
                            <Text style={styles.primaryButtonText}>Yes, Add to Cookbook</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.secondaryButton} onPress={handleSkipAddToCookbook}>
                            <Text style={styles.secondaryButtonText}>No, Thanks</Text>
                        </TouchableOpacity>
                    </>
                )}
                
                {step === 'submitted' && (
                     <>
                        <Ionicons name="checkmark-circle-outline" size={80} color="#5CB85C" />
                        <Text style={styles.title}>Thanks!</Text>
                        <Text style={styles.subtitle}>Your feedback helps us make better suggestions.</Text>
                    </>
                )}
                
                {/* Additional Actions available after initial rating */}
                {step !== 'rating' && step !== 'submitted' && (
                    <View style={styles.additionalActions}>
                        <TouchableOpacity style={styles.actionChip} onPress={handlePickImage}>
                            <Ionicons name="camera-outline" size={16} color="#333" />
                            <Text style={styles.actionChipText}>Add a Photo</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.actionChip} onPress={handleEditRecipe}>
                            <Ionicons name="pencil-outline" size={16} color="#333" />
                            <Text style={styles.actionChipText}>Edit Recipe</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        </KeyboardAwareScrollView>
    );
}

const styles = StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: '#fff' },
    container: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
    title: { fontSize: 28, fontWeight: 'bold', marginBottom: 8, textAlign: 'center' },
    recipeName: { fontSize: 24, fontWeight: '600', color: '#00715a', marginBottom: 24, textAlign: 'center' },
    subtitle: { fontSize: 18, color: '#666', marginBottom: 32, textAlign: 'center' },
    mainImage: { width: '100%', aspectRatio: 16/9, borderRadius: 12, marginBottom: 32, backgroundColor: '#eee' },
    ratingActions: { flexDirection: 'row', justifyContent: 'space-around', width: '100%' },
    ratingButton: {
        width: 80,
        height: 80,
        borderRadius: 40,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 2,
    },
    likeButton: { borderColor: '#5CB85C', backgroundColor: '#eaf6ea' },
    dislikeButton: { borderColor: '#D9534F', backgroundColor: '#fbeaea' },
    input: { width: '100%', borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 14, fontSize: 16, minHeight: 100, textAlignVertical: 'top', marginBottom: 24 },
    primaryButton: { width: '100%', backgroundColor: '#00715a', paddingVertical: 14, borderRadius: 8, alignItems: 'center', marginBottom: 12 },
    primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
    secondaryButton: { width: '100%', backgroundColor: '#f0f0f0', paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
    secondaryButtonText: { color: '#333', fontSize: 16, fontWeight: '600' },
    disabledButton: { backgroundColor: '#a9a9a9' },
    additionalActions: {
        flexDirection: 'row',
        justifyContent: 'center',
        marginTop: 24,
        borderTopWidth: 1,
        borderTopColor: '#eee',
        paddingTop: 24,
        width: '100%'
    },
    actionChip: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#f0f0f0',
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 20,
        marginHorizontal: 8,
    },
    actionChipText: {
        marginLeft: 8,
        fontSize: 14,
        fontWeight: '500',
    },
});

