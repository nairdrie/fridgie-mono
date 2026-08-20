// components/AddFromCookbookModal.tsx
//
// Pick a saved recipe and drop it straight into the current meal plan. The
// mirror image of AddToMealPlanModal, which starts from a recipe and asks which
// week; here the week is already known and we ask which recipe.

import { useAuth } from '@/context/AuthContext';
import { useLists } from '@/context/ListContext';
import { Recipe } from '@/types/types';
import { addRecipeToList, getUserCookbook } from '@/utils/api';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Image,
    Modal,
    SafeAreaView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

interface AddFromCookbookModalProps {
    isVisible: boolean;
    onClose: () => void;
    listId: string;
}

export default function AddFromCookbookModal({ isVisible, onClose, listId }: AddFromCookbookModalProps) {
    const { selectedGroup } = useLists();
    const { user } = useAuth();

    const [recipes, setRecipes] = useState<Recipe[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [submissionState, setSubmissionState] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
    const [submissionMessage, setSubmissionMessage] = useState('');
    const checkmarkAnimation = useSharedValue(0);

    // Fetch on open so a recipe saved since last time shows up.
    useEffect(() => {
        if (!isVisible || !user?.uid) return;
        let ignore = false;

        (async () => {
            setIsLoading(true);
            setLoadError(null);
            try {
                const cookbook = await getUserCookbook(user.uid);
                if (!ignore) setRecipes(Array.isArray(cookbook) ? cookbook : []);
            } catch (error: any) {
                if (!ignore) setLoadError(error?.message || 'Could not load your cookbook.');
            } finally {
                if (!ignore) setIsLoading(false);
            }
        })();

        return () => { ignore = true; };
    }, [isVisible, user?.uid]);

    useEffect(() => {
        if (!isVisible) {
            // Let the close animation finish before resetting.
            setTimeout(() => {
                setSubmissionState('idle');
                setSubmissionMessage('');
                setQuery('');
            }, 300);
        }
    }, [isVisible]);

    useEffect(() => {
        checkmarkAnimation.value = submissionState === 'success' ? withTiming(1, { duration: 400 }) : 0;
    }, [submissionState]);

    const animatedCheckmarkStyle = useAnimatedStyle(() => ({
        opacity: checkmarkAnimation.value,
        transform: [{ scale: 0.8 + checkmarkAnimation.value * 0.2 }],
    }));

    const visibleRecipes = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return recipes;
        return recipes.filter(r =>
            r.name?.toLowerCase().includes(q) ||
            r.tags?.some(t => t.toLowerCase().includes(q))
        );
    }, [recipes, query]);

    const handleSelectRecipe = async (recipe: Recipe) => {
        if (!selectedGroup || !listId) return;

        setSubmissionState('submitting');
        try {
            await addRecipeToList(selectedGroup.id, listId, recipe);
            setSubmissionMessage(`Added "${recipe.name}" to your meal plan!`);
            setSubmissionState('success');
            setTimeout(onClose, 1200);
        } catch (error: any) {
            setSubmissionMessage(error?.message || 'Could not add recipe. Please try again.');
            setSubmissionState('error');
        }
    };

    return (
        <Modal visible={isVisible} transparent animationType="slide" onRequestClose={onClose}>
            <TouchableOpacity style={styles.modalBackdrop} onPress={onClose} activeOpacity={1} />
            <SafeAreaView style={styles.modalContent}>
                {submissionState === 'submitting' && (
                    <View style={styles.feedbackContainer}>
                        <ActivityIndicator size="large" color={primary} />
                        <Text style={styles.feedbackText}>Adding Recipe...</Text>
                    </View>
                )}

                {submissionState === 'success' && (
                    <View style={styles.feedbackContainer}>
                        <Animated.View style={animatedCheckmarkStyle}>
                            <Ionicons name="checkmark-circle-outline" size={80} color="#28a745" />
                        </Animated.View>
                        <Text style={styles.feedbackText}>{submissionMessage}</Text>
                    </View>
                )}

                {submissionState === 'error' && (
                    <View style={styles.feedbackContainer}>
                        <Ionicons name="warning-outline" size={80} color="#dc3545" />
                        <Text style={[styles.feedbackText, { color: '#dc3545' }]}>{submissionMessage}</Text>
                        <TouchableOpacity style={styles.tryAgainButton} onPress={() => setSubmissionState('idle')}>
                            <Text style={styles.tryAgainButtonText}>OK</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {submissionState === 'idle' && (
                    <>
                        <Text style={styles.modalTitle}>From Cookbook</Text>
                        <Text style={styles.modalSubtitle}>Add one of your saved recipes</Text>

                        {recipes.length > 0 && (
                            <View style={styles.searchBox}>
                                <Ionicons name="search" size={18} color="#8a8a8a" />
                                <TextInput
                                    style={styles.searchInput}
                                    placeholder="Search your cookbook"
                                    placeholderTextColor="#8a8a8a"
                                    value={query}
                                    onChangeText={setQuery}
                                    autoCorrect={false}
                                    returnKeyType="search"
                                />
                                {query.length > 0 && (
                                    <TouchableOpacity onPress={() => setQuery('')}>
                                        <Ionicons name="close-circle" size={18} color="#c0c0c0" />
                                    </TouchableOpacity>
                                )}
                            </View>
                        )}

                        {isLoading ? (
                            <ActivityIndicator style={{ marginTop: 24 }} color={primary} />
                        ) : loadError ? (
                            <Text style={styles.emptyText}>{loadError}</Text>
                        ) : (
                            <FlatList
                                data={visibleRecipes}
                                keyExtractor={(item) => item.id}
                                keyboardShouldPersistTaps="handled"
                                renderItem={({ item }) => (
                                    <TouchableOpacity style={styles.recipeItem} onPress={() => handleSelectRecipe(item)}>
                                        {item.photoURL ? (
                                            <Image source={{ uri: item.photoURL }} style={styles.recipePhoto} />
                                        ) : (
                                            <View style={[styles.recipePhoto, styles.recipePhotoPlaceholder]}>
                                                <Ionicons name="restaurant-outline" size={22} color="#b0b0b0" />
                                            </View>
                                        )}
                                        <View style={styles.recipeInfo}>
                                            <Text style={styles.recipeName} numberOfLines={1}>{item.name}</Text>
                                            {!!item.description && (
                                                <Text style={styles.recipeDescription} numberOfLines={1}>{item.description}</Text>
                                            )}
                                        </View>
                                        <Ionicons name="add-circle-outline" size={24} color={primary} />
                                    </TouchableOpacity>
                                )}
                                ListEmptyComponent={
                                    <Text style={styles.emptyText}>
                                        {query
                                            ? `No recipes match "${query}".`
                                            : 'Your cookbook is empty. Save a recipe to add it here.'}
                                    </Text>
                                }
                            />
                        )}
                    </>
                )}
            </SafeAreaView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    emptyText: { textAlign: 'center', marginTop: 20, color: '#6c757d' },
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
    // paddingTop over the uniform 20: the title is the first thing in the
    // sheet, and 20 put it hard against a 20-radius top edge, so it read as
    // clipped rather than headed.
    modalContent: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#f8f9fa', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingTop: 28, maxHeight: '70%', minHeight: '45%' },
    modalTitle: { fontSize: 22, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 },
    modalSubtitle: { fontSize: 16, color: '#6c757d', textAlign: 'center', marginBottom: 16 },
    searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e9ecef', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 },
    searchInput: { flex: 1, fontSize: 16, padding: 0 },
    recipeItem: { backgroundColor: '#fff', padding: 12, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10, borderWidth: 1, borderColor: '#e9ecef' },
    recipePhoto: { width: 48, height: 48, borderRadius: 8, backgroundColor: '#f0f0f0' },
    recipePhotoPlaceholder: { justifyContent: 'center', alignItems: 'center' },
    recipeInfo: { flex: 1 },
    recipeName: { fontSize: 16, fontWeight: '500' },
    recipeDescription: { fontSize: 14, color: '#6c757d', marginTop: 2 },
    feedbackContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
    feedbackText: { marginTop: 16, fontSize: 18, fontWeight: '600', textAlign: 'center', color: '#495057' },
    tryAgainButton: { marginTop: 24, backgroundColor: primary, paddingVertical: 12, paddingHorizontal: 40, borderRadius: 25 },
    tryAgainButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
});
