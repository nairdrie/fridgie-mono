// components/AddFromCookbookModal.tsx
//
// Pick a saved recipe and drop it straight into the current meal plan. The
// mirror image of AddToMealPlanModal, which starts from a recipe and asks which
// week; here the week is already known and we ask which recipe.

import { useAuth } from '@/context/AuthContext';
import { useLists } from '@/context/ListContext';
import { useCookbookFilter } from '@/hooks/useCookbookFilter';
import { Recipe } from '@/types/types';
import { addRecipeToList, getUserCookbook } from '@/utils/api';
import { ink, inkMuted, primary } from '@/utils/styles';
import { GlassPressable, GlassSurface, useGlassPreferences } from '@/components/ui/Glass';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Image,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    View
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import CookbookFilterBar from './CookbookFilterBar';

interface AddFromCookbookModalProps {
    isVisible: boolean;
    onClose: () => void;
    listId: string;
}

export default function AddFromCookbookModal({ isVisible, onClose, listId }: AddFromCookbookModalProps) {
    const insets = useSafeAreaInsets();
    const { reduceMotion } = useGlassPreferences();
    const { selectedGroup } = useLists();
    const { user } = useAuth();

    const [recipes, setRecipes] = useState<Recipe[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [submissionState, setSubmissionState] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
    const [submissionMessage, setSubmissionMessage] = useState('');
    const checkmarkAnimation = useSharedValue(0);

    // Same search and the same category chips as the cookbook itself, so a
    // recipe is found here by whatever found it there. No sort control: this is
    // a picker, and newest-first is what you want when you have just saved the
    // thing you came to add.
    const filter = useCookbookFilter(recipes);
    const { reset: resetFilter } = filter;

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
                resetFilter();
            }, 300);
        }
    }, [isVisible, resetFilter]);

    useEffect(() => {
        checkmarkAnimation.value = submissionState === 'success' ? withTiming(1, { duration: reduceMotion ? 0 : 400 }) : 0;
    }, [submissionState, reduceMotion, checkmarkAnimation]);

    const animatedCheckmarkStyle = useAnimatedStyle(() => ({
        opacity: checkmarkAnimation.value,
        transform: [{ scale: 0.8 + checkmarkAnimation.value * 0.2 }],
    }));

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
        <Modal visible={isVisible} transparent animationType={reduceMotion ? "none" : "slide"} onRequestClose={onClose}>
            <Pressable style={styles.modalBackdrop} onPress={onClose} accessibilityLabel="Close sheet" />
            <GlassSurface style={[styles.modalContent, { paddingBottom: Math.max(insets.bottom, 24) }]} intensity={85}>
                <View style={styles.sheetHandle} />
                <GlassPressable style={styles.closeButton} onPress={onClose} accessibilityLabel="Close sheet"><Ionicons name="close" size={20} color={ink} /></GlassPressable>
                {submissionState === 'submitting' && (
                    <View style={styles.feedbackContainer}>
                        <ActivityIndicator size="large" color={primary} />
                        <Text style={styles.feedbackText}>Making room at the table…</Text>
                    </View>
                )}

                {submissionState === 'success' && (
                    <View style={styles.feedbackContainer}>
                        <Animated.View style={animatedCheckmarkStyle}>
                            <Ionicons name="checkmark-circle-outline" size={80} color={primary} />
                        </Animated.View>
                        <Text style={styles.feedbackText}>{submissionMessage}</Text>
                    </View>
                )}

                {submissionState === 'error' && (
                    <View style={styles.feedbackContainer}>
                        <Ionicons name="warning-outline" size={80} color="#B8534B" />
                        <Text style={[styles.feedbackText, { color: '#B8534B' }]}>{submissionMessage}</Text>
                        <GlassPressable style={styles.tryAgainButton} onPress={() => setSubmissionState('idle')}>
                            <Text style={styles.tryAgainButtonText}>OK</Text>
                        </GlassPressable>
                    </View>
                )}

                {submissionState === 'idle' && (
                    <>
                        <Text style={styles.modalTitle}>From Cookbook</Text>
                        <Text style={styles.modalSubtitle}>Add one of your saved recipes</Text>

                        {recipes.length > 0 && (
                            <View style={styles.searchBox}>
                                <Ionicons name="search" size={18} color={inkMuted} />
                                <TextInput
                                    style={styles.searchInput}
                                    placeholder="Search your cookbook"
                                    accessibilityLabel="Search your cookbook"
                                    placeholderTextColor={inkMuted}
                                    value={filter.searchTerm}
                                    onChangeText={filter.setSearchTerm}
                                    autoCorrect={false}
                                    returnKeyType="search"
                                />
                                {filter.searchTerm.length > 0 && (
                                    <GlassPressable onPress={() => filter.setSearchTerm('')} accessibilityLabel="Clear cookbook search">
                                        <Ionicons name="close-circle" size={18} color="#c0c0c0" />
                                    </GlassPressable>
                                )}
                            </View>
                        )}

                        {recipes.length > 0 && (
                            <CookbookFilterBar
                                chips={filter.chips}
                                selected={filter.category}
                                onSelect={filter.setCategory}
                                sort={filter.sort}
                                onSortChange={filter.setSort}
                                showSort={false}
                            />
                        )}

                        {isLoading ? (
                            <ActivityIndicator style={{ marginTop: 24 }} color={primary} />
                        ) : loadError ? (
                            <Text style={styles.emptyText}>{loadError}</Text>
                        ) : (
                            <FlatList
                                data={filter.recipes}
                                keyExtractor={(item) => item.id}
                                keyboardShouldPersistTaps="handled"
                                renderItem={({ item }) => (
                                    <GlassPressable style={styles.recipeItem} onPress={() => handleSelectRecipe(item)} accessibilityLabel={`Add ${item.name} to the meal plan`}>
                                        {item.photoURL ? (
                                            <Image source={{ uri: item.photoURL }} style={styles.recipePhoto} />
                                        ) : (
                                            <View style={[styles.recipePhoto, styles.recipePhotoPlaceholder]}>
                                                <Ionicons name="restaurant-outline" size={22} color={primary} />
                                            </View>
                                        )}
                                        <View style={styles.recipeInfo}>
                                            <Text style={styles.recipeName} numberOfLines={1}>{item.name}</Text>
                                            {!!item.description && (
                                                <Text style={styles.recipeDescription} numberOfLines={1}>{item.description}</Text>
                                            )}
                                        </View>
                                        <Ionicons name="add-circle-outline" size={24} color={primary} />
                                    </GlassPressable>
                                )}
                                ListEmptyComponent={
                                    <Text style={styles.emptyText}>
                                        {filter.isFiltered
                                            ? 'No recipes match that.'
                                            : 'Your cookbook is empty. Save a recipe to add it here.'}
                                    </Text>
                                }
                            />
                        )}
                    </>
                )}
            </GlassSurface>
        </Modal>
    );
}

const styles = StyleSheet.create({
    emptyText: { textAlign: 'center', marginTop: 24, color: inkMuted, fontSize: 14, lineHeight: 22 },
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,37,28,0.3)' },
    modalContent: { position: 'absolute', bottom: 0, left: 0, right: 0, borderRadius: 0, borderTopLeftRadius: 34, borderTopRightRadius: 34, overflow: 'hidden', paddingHorizontal: 22, paddingTop: 10, maxHeight: '78%', minHeight: '44%', backgroundColor: '#F5F5EF' },
    sheetHandle: { width: 34, height: 4, borderRadius: 2, alignSelf: 'center', backgroundColor: '#C0CABF', marginBottom: 24 },
    closeButton: { position: 'absolute', right: 18, top: 21, width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center', backgroundColor: '#E5EDE3', zIndex: 1 },
    modalTitle: { fontSize: 27, fontWeight: '700', letterSpacing: -0.9, color: ink, marginBottom: 8, paddingRight: 34 },
    modalSubtitle: { fontSize: 14, lineHeight: 21, color: inkMuted, marginBottom: 24 },
    feedbackContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, minHeight: 220 },
    feedbackText: { marginTop: 18, fontSize: 18, lineHeight: 25, fontWeight: '600', textAlign: 'center', color: ink },
    tryAgainButton: { marginTop: 24, backgroundColor: primary, paddingVertical: 14, paddingHorizontal: 40, borderRadius: 25 },
    tryAgainButtonText: { color: '#FFF', fontSize: 15, fontWeight: '700' },
    searchBox: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: 'rgba(255,255,255,0.85)', borderWidth: 1, borderColor: '#FFF', borderRadius: 23, paddingHorizontal: 16, minHeight: 50, marginBottom: 14 },
    searchInput: { flex: 1, fontSize: 15, paddingVertical: 12, color: ink },
    recipeItem: { backgroundColor: 'rgba(255,255,255,0.8)', padding: 9, borderRadius: 24, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10, borderWidth: 1, borderColor: '#FFF', paddingRight: 16 },
    recipePhoto: { width: 62, height: 66, borderRadius: 17, backgroundColor: '#DCEDE2' },
    recipePhotoPlaceholder: { justifyContent: 'center', alignItems: 'center' },
    recipeInfo: { flex: 1 },
    recipeName: { fontSize: 16, fontWeight: '700', letterSpacing: -0.35, color: ink },
    recipeDescription: { fontSize: 12, color: inkMuted, marginTop: 5 },
});
