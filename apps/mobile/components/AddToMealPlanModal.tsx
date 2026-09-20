// components/AddToMealPlanModal.tsx
import { useLists } from '@/context/ListContext';
import { List, Recipe } from '@/types/types';
import { addRecipeToList } from '@/utils/api';
import { getWeekLabel, parseWeekEnd, parseWeekStart } from '@/utils/date';
import { startOfWeek } from 'date-fns';
import { ink, inkMuted, primary } from '@/utils/styles';
import { GlassPressable, GlassSurface, useGlassPreferences } from '@/components/ui/Glass';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    View
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

interface AddToMealPlanModalProps {
    isVisible: boolean;
    onClose: () => void;
    recipe: Recipe | null;
}

export default function AddToMealPlanModal({ isVisible, onClose, recipe }: AddToMealPlanModalProps) {
    const insets = useSafeAreaInsets();
    const { reduceMotion } = useGlassPreferences();
    const { allLists, isLoading: areListsLoading, selectedGroup } = useLists();
    const [submissionState, setSubmissionState] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
    const [submissionMessage, setSubmissionMessage] = useState('');
    const checkmarkAnimation = useSharedValue(0);

    // Effect to reset state when the modal becomes invisible
    useEffect(() => {
        if (!isVisible) {
            // Add a small delay to allow the closing animation to finish
            setTimeout(() => {
                setSubmissionState('idle');
                setSubmissionMessage('');
            }, 300);
        }
    }, [isVisible]);

    useEffect(() => {
        if (submissionState === 'success') {
            checkmarkAnimation.value = withTiming(1, { duration: reduceMotion ? 0 : 400 });
        } else {
            checkmarkAnimation.value = 0;
        }
    }, [submissionState, reduceMotion, checkmarkAnimation]);

    const animatedCheckmarkStyle = useAnimatedStyle(() => ({
        opacity: checkmarkAnimation.value,
        transform: [{ scale: 0.8 + checkmarkAnimation.value * 0.2 }],
    }));

    const displayLists = useMemo(() => {
        if (!allLists) return [];
        const startOfThisWeekTime = startOfWeek(new Date(), { weekStartsOn: 0 }).getTime();
        return allLists
            .filter(list => parseWeekStart(list.weekStart).getTime() >= startOfThisWeekTime)
            .sort((a, b) => parseWeekStart(a.weekStart).getTime() - parseWeekStart(b.weekStart).getTime());
    }, [allLists]);

    const handleSelectWeek = async (list: List) => {
        if (!selectedGroup || !recipe) return;

        setSubmissionState('submitting');
        try {
            await addRecipeToList(selectedGroup.id, list.id, recipe);
            setSubmissionMessage(`Added "${recipe.name}" to your meal plan!`);
            setSubmissionState('success');

            setTimeout(() => {
                onClose();
            }, 1500);
        } catch (error: any) {
            setSubmissionMessage(error.message || "Could not add recipe. Please try again.");
            setSubmissionState('error');
        }
    };

    return (
        <Modal
            visible={isVisible}
            transparent={true}
            animationType={reduceMotion ? "none" : "slide"}
            onRequestClose={onClose}
        >
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
                        <Text style={styles.modalTitle}>Add to Meal Plan</Text>
                        <Text style={styles.modalSubtitle}>Select a week for “{recipe?.name}”</Text>
                        {areListsLoading ? (
                            <ActivityIndicator />
                        ) : (
                            <FlatList
                                data={displayLists}
                                keyExtractor={(item) => item.id}
                                renderItem={({ item }) => (
                                    <GlassPressable style={styles.weekItem} onPress={() => handleSelectWeek(item)} accessibilityLabel={`Add recipe to ${getWeekLabel(item.weekStart)}`}>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, flex: 1 }}><View style={styles.weekIcon}><Ionicons name="calendar-outline" size={23} color={primary} /></View><View>
                                            <Text style={styles.weekText}>{getWeekLabel(item.weekStart)}</Text>
                                            <Text style={styles.weekSubText}>
                                                {parseWeekStart(item.weekStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - {parseWeekEnd(item.weekStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                            </Text>
                                        </View></View>
                                        <Ionicons name="chevron-forward" size={22} color={primary} />
                                    </GlassPressable>
                                )}
                                ListEmptyComponent={<Text style={styles.emptyText}>No upcoming meal plans found.</Text>}
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
    weekItem: { backgroundColor: 'rgba(255,255,255,0.8)', paddingVertical: 16, paddingHorizontal: 16, borderRadius: 24, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#FFF' },
    weekIcon: { width: 47, height: 47, borderRadius: 17, backgroundColor: '#DCEDE2', alignItems: 'center', justifyContent: 'center' },
    weekText: { fontSize: 16, fontWeight: '700', letterSpacing: -0.3, color: ink },
    weekSubText: { fontSize: 12, color: inkMuted, marginTop: 5 },
});
