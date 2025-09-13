import Logo from '@/components/Logo'; // 1. Import your Logo component
import { Recipe } from '@/types/types';
import { getExploreContent } from '@/utils/api';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';


// A reusable component for the horizontal carousels (no changes needed here)
const RecipeCarousel = ({ title, recipes }: { title: string; recipes: Recipe[] }) => (
    <View style={styles.carouselContainer}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <FlatList
            data={recipes}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
                <TouchableOpacity style={styles.recipeCard}>
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

    // 2. The JSX is restructured to create the new layout
    return (
        <>
            <StatusBar style="light" />
            <SafeAreaView style={{ flex: 1, backgroundColor: '#0b2215' }} edges={['top']}>
                <View style={styles.pageContainer}>
                    {/* Header section that sits on the dark background */}
                    <View style={styles.headerContent}>
                        <Logo variant="small" style={styles.logo} />
                        <View style={styles.searchContainer}>
                            <Ionicons name="search" size={20} color="#888" style={styles.searchIcon} />
                            <TextInput
                                style={styles.searchInput}
                                placeholder="Search recipes & users..."
                                placeholderTextColor="#c4c4c4ff"
                                value={searchQuery}
                                onChangeText={setSearchQuery}
                                onSubmitEditing={handleSearch}
                                returnKeyType="search"
                            />
                        </View>
                    </View>

                    {/* White content card that holds the scrollable content */}
                    <View style={styles.contentCard}>
                        {isLoading ? (
                            <ActivityIndicator size="large" style={{ marginTop: 50 }} />
                        ) : (
                            <ScrollView showsVerticalScrollIndicator={false}>
                                {exploreData?.featured?.length > 0 && (
                                    <RecipeCarousel title="Featured Recipes" recipes={exploreData.featured} />
                                )}
                                {exploreData?.trending?.length > 0 && (
                                    <RecipeCarousel title="Trending Now" recipes={exploreData.trending} />
                                )}
                                {exploreData?.newest?.length > 0 && (
                                    <RecipeCarousel title="Recently Added" recipes={exploreData.newest} />
                                )}
                            </ScrollView>
                        )}
                    </View>
                </View>
            </SafeAreaView>
        </>
    );
}

// 3. The StyleSheet is updated with new and modified styles
const styles = StyleSheet.create({
    // --- New Styles for the Layout ---
    pageContainer: {
        flex: 1,
        backgroundColor: '#0b2215',
    },
    headerContent: {
        flexDirection: 'row',
        alignItems: 'center',
        // paddingHorizontal: 16,
        paddingVertical: 12,
    },
    logo: {
        width: 60,
        height: 60,
        // marginRight: 12,
        margin: 0
    },
    contentCard: {
        flex: 1,
        backgroundColor: 'white',
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingTop: 16, // Add space between card edge and first carousel
    },

    // --- Modified & Existing Styles ---
    searchContainer: {
        flex: 1, // Take remaining space
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.15)', // A subtle transparent white looks good on green
        borderRadius: 30, // Make it pill-shaped
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
        color: '#fff', // White text for the dark background
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