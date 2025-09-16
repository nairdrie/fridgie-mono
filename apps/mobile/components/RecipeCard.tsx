// components/RecipeCard.tsx

import { Recipe } from '@/types/types';
import { primary } from '@/utils/styles';
import { format } from 'date-fns';
import React from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface RecipeCardProps {
    recipe: Recipe;
    onAddToMealPlan: (recipe: Recipe) => void;
    onView: (recipeId: string) => void;
}

export default function RecipeCard({ recipe, onAddToMealPlan, onView }: RecipeCardProps) {
    const handlePress = () => {
        onView(recipe.id);
    };

    return (
        <TouchableOpacity style={styles.cardContainer} onPress={handlePress}>
            {recipe.photoURL ? (
                <Image
                    source={{ uri: recipe.photoURL }}
                    style={styles.cardImage}
                />
            ) : (
                <Image
                    source={require('../assets/images/plate.png')}
                    style={styles.cardImage}
                />
            )}
            <View style={styles.cardContent}>
                <Text style={styles.cardTitle} numberOfLines={1}>{recipe.name}</Text>
                {recipe.lastAte && (
                    <View style={styles.dateLabel}>
                        <Text style={styles.dateLabelText}>
                            {format(new Date(recipe.lastAte), 'MMM d, yyyy')}
                        </Text>
                    </View>
                )}
                {recipe.authorName && 
                    <View>
                        <Text style={styles.dateLabelText}>
                            {recipe.authorName}
                        </Text>
                    </View>
                }
                <Text style={styles.cardDescription} numberOfLines={2}>{recipe.description}</Text>
            </View>
            {/* <TouchableOpacity style={styles.addButton} onPress={() => onAddToMealPlan(recipe)}>
                <Ionicons name="add-circle" size={36} color={primary} />
            </TouchableOpacity> */}
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    cardContainer: { backgroundColor: '#fff', borderRadius: 12, marginBottom: 16, flexDirection: 'row', overflow: 'hidden', borderColor: '#ddd', borderWidth: 1 },
    cardImage: { width: 100, height: '100%' },
    cardContent: { flex: 1, padding: 12 },
    cardTitle: { fontSize: 16, fontWeight: 'bold'},
    cardDescription: { fontSize: 13, color: '#6c757d', lineHeight: 18 },
    addButton: { justifyContent: 'center', paddingHorizontal: 10 },
    dateLabel: {
        alignSelf: 'flex-start',
        width: 'auto',
        flexDirection: 'row',
        alignItems: 'center',
        // paddingVertical: 4,
        // paddingHorizontal: 8,
        // backgroundColor: '#eefff2ff',
        borderRadius: 12,
        marginBottom: 8,
    },
    dateLabelText: {
        // marginHorizontal: 5,
        marginBottom: 3,
        color: primary,
        fontWeight: '500',
        fontSize: 12,
    }
});