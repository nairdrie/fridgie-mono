import { GlassPressable } from '@/components/ui/Glass';
import { Recipe } from '@/types/types';
import { getCardStyleFromTags } from '@/utils/recipeStyling';
import { ink, inkMuted, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

interface RecipeCardProps {
    recipe: Recipe;
    onAddToMealPlan: (recipe: Recipe) => void;
    onView: (recipeId: string) => void;
}

export default function RecipeCard({ recipe, onView }: RecipeCardProps) {
    return (
        <GlassPressable
            style={styles.card}
            onPress={() => onView(recipe.id)}
            accessibilityRole="button"
            accessibilityLabel={`View ${recipe.name}${recipe.authorName ? `, by ${recipe.authorName}` : ''}`}
        >
            {recipe.photoURL ? <Image source={{ uri: recipe.photoURL }} style={styles.image} /> : (
                <View style={[styles.image, styles.imagePlaceholder]}>
                    <View style={styles.imageOrb} />
                    <Ionicons name={getCardStyleFromTags(recipe.tags).icon} size={37} color={primary} />
                </View>
            )}
            <View style={styles.content}>
                <Text style={styles.category} numberOfLines={1}>{recipe.category || 'From the cookbook'}</Text>
                <Text style={styles.title} numberOfLines={2}>{recipe.name}</Text>
                {!!recipe.description && <Text style={styles.description} numberOfLines={1}>{recipe.description}</Text>}
                <View style={styles.bottomRow}>
                    <Text style={styles.author} numberOfLines={1}>{recipe.authorName ? `By ${recipe.authorName}` : recipe.servings ? `Serves ${recipe.servings}` : 'Made for your table'}</Text>
                    <View style={styles.arrow}><Ionicons name="arrow-forward" size={13} color={primary} /></View>
                </View>
            </View>
        </GlassPressable>
    );
}

const styles = StyleSheet.create({
    card: { backgroundColor: 'rgba(255,255,255,0.8)', borderWidth: 1, borderColor: '#FFF', borderRadius: 26, marginBottom: 12, padding: 8, flexDirection: 'row', alignItems: 'stretch', gap: 14, shadowColor: '#173F35', shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.035, shadowRadius: 12, elevation: 1 },
    image: { width: 104, minHeight: 126, borderRadius: 20, backgroundColor: '#DCEDE2' },
    imagePlaceholder: { overflow: 'hidden', justifyContent: 'center', alignItems: 'center' },
    imageOrb: { width: 100, height: 100, borderRadius: 50, backgroundColor: '#D0E2CF', position: 'absolute', top: -25, right: -35 },
    content: { flex: 1, paddingVertical: 6, paddingRight: 6 },
    category: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', color: primary, marginBottom: 6 },
    title: { fontSize: 17, lineHeight: 21, fontWeight: '700', color: ink, letterSpacing: -0.4 },
    description: { fontSize: 12, lineHeight: 17, color: inkMuted, marginTop: 5 },
    bottomRow: { flexDirection: 'row', alignItems: 'center', marginTop: 9, gap: 5 },
    author: { flex: 1, fontSize: 11, color: inkMuted },
    arrow: { width: 23, height: 23, backgroundColor: '#E5EFE6', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
