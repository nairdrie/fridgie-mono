// components/RecipeCard.tsx

import { Recipe } from '@/types/types';
import { hairline, ink, inkFaint, inkMuted, primary, surface } from '@/utils/styles';
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
                {/* Above the title rather than beside it: it is how the card is
                    filed, not what the card is, and a chip on the right would
                    fight the title for the same line on a narrow phone. Absent
                    on recipes the server hasn't categorized yet. */}
                {!!recipe.category && (
                    <Text style={styles.cardCategory} numberOfLines={1}>{recipe.category}</Text>
                )}
                <Text style={styles.cardTitle} numberOfLines={1}>{recipe.name}</Text>
                {recipe.authorName && (
                    <Text style={styles.cardAuthor} numberOfLines={1}>
                        by <Text style={styles.cardAuthorName}>{recipe.authorName}</Text>
                    </Text>
                )}
                <Text style={styles.cardDescription} numberOfLines={2}>{recipe.description}</Text>
            </View>
            {/* <TouchableOpacity style={styles.addButton} onPress={() => onAddToMealPlan(recipe)}>
                <Ionicons name="add-circle" size={36} color={primary} />
            </TouchableOpacity> */}
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    // A soft tile rather than a bordered box: these sit on white in Explore and
    // the Cookbook, and the fill separates them more quietly than a hairline did.
    cardContainer: { backgroundColor: surface, borderRadius: 16, marginBottom: 12, flexDirection: 'row', overflow: 'hidden' },
    cardImage: { width: 96, height: '100%', backgroundColor: hairline },
    cardContent: { flex: 1, paddingVertical: 12, paddingHorizontal: 14 },
    cardCategory: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', color: inkFaint, marginBottom: 3 },
    cardTitle: { fontSize: 16, fontWeight: '600', color: ink, letterSpacing: -0.2 },
    cardAuthor: { fontSize: 13, color: inkMuted, marginTop: 2 },
    cardAuthorName: { color: primary, fontWeight: '600' },
    cardDescription: { fontSize: 13, lineHeight: 18, color: inkMuted, marginTop: 6 },
    addButton: { justifyContent: 'center', paddingHorizontal: 10 },
});
