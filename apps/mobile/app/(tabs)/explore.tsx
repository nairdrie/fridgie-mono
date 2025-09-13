import Logo from '@/components/Logo';
import ViewRecipeModal from '@/components/ViewRecipeModal'; // 1. Import the modal
import { Recipe } from '@/types/types';
import { getExploreContent } from '@/utils/api';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Updated RecipeCarousel to accept the onView handler
const RecipeCarousel = ({ title, recipes, onView }: { title: string; recipes: Recipe[], onView: (recipeId: string) => void; }) => (
    <View style={styles.carouselContainer}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <FlatList
            data={recipes}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
                <TouchableOpacity style={styles.recipeCard} onPress={() => onView(item.id)}>
                    <Image source={{ uri: item.photoURL }} style={styles.recipeImage} />
                    <Text style={styles.recipeName} numberOfLines={2}>{item.name}</Text>
                </TouchableOpacity>
            )}
        />
    </View>
);

export default function ExploreScreen() {
    const [searchQuery, setSearchQuery] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [exploreData, setExploreData] = useState<any>(null);
    const [recipeToViewId, setRecipeToViewId] = useState<string | null>(null); // 2. Add state for the modal

    const [isFocused, setIsFocused] = useState(false);
    useFocusEffect(
        useCallback(() => {
            setIsFocused(true); // Screen is focused
            return () => {
                setIsFocused(false); // Screen is unfocused
            };
        }, [])
    );


    useEffect(() => {
        const fetchContent = async () => {
            try {
                setIsLoading(true);
                const content = await getExploreContent();
                setExploreData(content);
            } catch (error) {
                console.error(error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchContent();
    }, []);
    
    const handleSearch = () => {
        if (!searchQuery) return;
        console.log(`Searching for: ${searchQuery}`);
    };

    // 3. Handler to open the recipe view modal
    const handleViewRecipe = (recipeId: string) => {
        setRecipeToViewId(recipeId);
    };

    return (
        <>
            {isFocused && <StatusBar style="light" />}
            <SafeAreaView style={{ flex: 1, backgroundColor: '#0b2215' }} edges={['top']}>
                <View style={styles.pageContainer}>
                    <View style={styles.headerContent}>
                        <Logo variant="small" style={styles.logo} />
                        <View style={styles.searchContainer}>
                            <Ionicons name="search" size={20} color="#888" style={styles.searchIcon} />
                            <TextInput
                                style={styles.searchInput}
                                placeholder="Search people and recipes..."
                                placeholderTextColor="#c4c4c4ff"
                                value={searchQuery}
                                onChangeText={setSearchQuery}
                                onSubmitEditing={handleSearch}
                                returnKeyType="search"
                            />
                        </View>
                    </View>

                    <View style={styles.contentCard}>
                        {isLoading ? (
                            <ActivityIndicator size="large" style={{ marginTop: 50 }} />
                        ) : (
                            <ScrollView showsVerticalScrollIndicator={false}>
                                {exploreData?.featured?.length > 0 && (
                                    <RecipeCarousel title="Featured" recipes={exploreData.featured} onView={handleViewRecipe} />
                                )}
                                {exploreData?.trending?.length > 0 && (
                                    <RecipeCarousel title="Trending" recipes={exploreData.trending} onView={handleViewRecipe} />
                                )}
                                {exploreData?.newest?.length > 0 && (
                                    <RecipeCarousel title="Recent" recipes={exploreData.newest} onView={handleViewRecipe} />
                                )}
                            </ScrollView>
                        )}
                    </View>
                </View>
            </SafeAreaView>

            {/* 4. Add the ViewRecipeModal component */}
            <ViewRecipeModal
                isVisible={!!recipeToViewId}
                onClose={() => setRecipeToViewId(null)}
                recipeId={recipeToViewId}
                // These props are optional and depend on whether you want users
                // to be able to edit/save recipes directly from the Explore page.
                // For a view-only experience, you can omit them or pass dummy functions.
                isInCookbook={false} // Or you can check this against the user's cookbook
                onCookbookUpdate={() => { /* maybe refresh cookbook context */}}
                onEdit={() => { /* TBD: decide if you want edit from here */}}
            />
        </>
    );
}

// Styles remain the same
const styles = StyleSheet.create({
    pageContainer: {
        flex: 1,
        backgroundColor: '#0b2215',
    },
    headerContent: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
    },
    logo: {
        width: 60,
        height: 60,
        margin: 0
    },
    contentCard: {
        flex: 1,
        backgroundColor: 'white',
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingTop: 16,
    },
    searchContainer: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.15)',
        borderRadius: 30,
        paddingHorizontal: 15,
        height: 44,
        marginLeft: 0,
        marginRight:10
    },
    searchIcon: { marginRight: 8, color: '#ffffffff' },
    searchInput: {
        flex: 1,
        height: '100%',
        fontSize: 16,
        color: '#fff',
    },
    sectionTitle: {
        fontSize: 22,
        fontWeight: 'bold',
        marginLeft: 16,
        marginBottom: 12,
    },
    carouselContainer: {
        marginBottom: 24,
    },
    recipeCard: {
        width: 150,
        marginLeft: 16,
    },
    recipeImage: {
        width: '100%',
        height: 150,
        borderRadius: 10,
        backgroundColor: '#eee',
    },
    recipeName: {
        marginTop: 8,
        fontSize: 14,
        fontWeight: '600',
    },
});

