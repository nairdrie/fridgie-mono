// components/AddToMealPlanModal.tsx
import { useLists } from '@/context/ListContext';
import { List, Recipe } from '@/types/types';
import { addRecipeToList } from '@/utils/api';
import { getWeekLabel } from '@/utils/date';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Modal,
    SafeAreaView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

interface AddToMealPlanModalProps {
    isVisible: boolean;
    onClose: () => void;
    recipe: Recipe | null;
}

export default function AddToMealPlanModal({ isVisible, onClose, recipe }: AddToMealPlanModalProps) {
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
            checkmarkAnimation.value = withTiming(1, { duration: 400 });
        } else {
            checkmarkAnimation.value = 0;
        }
    }, [submissionState]);

    const animatedCheckmarkStyle = useAnimatedStyle(() => ({
        opacity: checkmarkAnimation.value,
        transform: [{ scale: 0.8 + checkmarkAnimation.value * 0.2 }],
    }));

    const displayLists = useMemo(() => {
        if (!allLists) return [];
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const startOfThisWeek = new Date(today);
        startOfThisWeek.setDate(today.getDate() - today.getDay());
        const startOfThisWeekTime = startOfThisWeek.getTime();
        return allLists
            .filter(list => new Date(list.weekStart).getTime() >= startOfThisWeekTime)
            .sort((a, b) => new Date(a.weekStart).getTime() - new Date(b.weekStart).getTime());
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
            animationType="slide"
            onRequestClose={onClose}
        >
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
                        <Text style={styles.modalTitle}>Add to Meal Plan</Text>
                        <Text style={styles.modalSubtitle}>Select a week for "{recipe?.name}"</Text>
                        {areListsLoading ? (
                            <ActivityIndicator />
                        ) : (
                            <FlatList
                                data={displayLists}
                                keyExtractor={(item) => item.id}
                                renderItem={({ item }) => (
                                    <TouchableOpacity style={styles.weekItem} onPress={() => handleSelectWeek(item)}>
                                        <View>
                                            <Text style={styles.weekText}>{getWeekLabel(item.weekStart)}</Text>
                                            <Text style={styles.weekSubText}>
                                                {new Date(item.weekStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - {new Date(new Date(item.weekStart).getTime() + 6 * 24 * 60 * 60 * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                            </Text>
                                        </View>
                                        <Ionicons name="chevron-forward" size={22} color="#666" />
                                    </TouchableOpacity>
                                )}
                                ListEmptyComponent={<Text style={styles.emptyText}>No upcoming meal plans found.</Text>}
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
    modalContent: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#f8f9fa', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '60%', minHeight: '40%' },
    modalTitle: { fontSize: 22, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 },
    modalSubtitle: { fontSize: 16, color: '#6c757d', textAlign: 'center', marginBottom: 24 },
    weekItem: { backgroundColor: '#fff', paddingVertical: 16, paddingHorizontal: 20, borderRadius: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#e9ecef' },
    weekText: { fontSize: 16, fontWeight: '500' },
    weekSubText: { fontSize: 14, color: '#6c757d', marginTop: 4 },
    feedbackContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
    feedbackText: { marginTop: 16, fontSize: 18, fontWeight: '600', textAlign: 'center', color: '#495057' },
    tryAgainButton: { marginTop: 24, backgroundColor: primary, paddingVertical: 12, paddingHorizontal: 40, borderRadius: 25 },
    tryAgainButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
});