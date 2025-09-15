import Logo from '@/components/Logo';
import ViewRecipeModal from '@/components/ViewRecipeModal';
import { Recipe } from '@/types/types';
import { getExploreContent } from '@/utils/api';
import { getCardStyleFromTags } from '@/utils/recipeStyling';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// --- Types for our new Creator section ---
interface Creator {
    uid: string;
    displayName: string;
    photoURL: string;
    followers: number;
    recipeCount: number;
    popularRecipe: {
        name: string;
        photoURL: string;
    };
}

// --- MOCK DATA for Featured Creators ---
// Moved outside the component to prevent re-creation on every render, which caused the infinite loop.
const featuredCreators: Creator[] = [
    { uid: '1', displayName: 'J. Kenji López-Alt', photoURL: 'https://i.pravatar.cc/150?u=1', followers: 125000, recipeCount: 84, popularRecipe: { name: 'Crispy Smashed Potatoes', photoURL: 'https://images.unsplash.com/photo-1615995219758-c8de1594a111?w=400' } },
    { uid: '2', displayName: 'Yotam Ottolenghi', photoURL: 'https://i.pravatar.cc/150?u=2', followers: 210000, recipeCount: 112, popularRecipe: { name: 'Roasted Eggplant with Tahini', photoURL: 'https://images.unsplash.com/photo-1620117654382-efe99965b833?w=400' } },
    { uid: '3', displayName: 'Alison Roman', photoURL: 'https://i.pravatar.cc/150?u=3', followers: 98000, recipeCount: 65, popularRecipe: { name: 'The Stew', photoURL: 'https://images.unsplash.com/photo-1548943487-a2e4e43b4853?w=400' } },
];

// Reusable component for the horizontal recipe carousels
const RecipeCarousel = ({ title, recipes, onView }: { title: string; recipes: Recipe[], onView: (recipeId:string) => void; }) => {
    
    const renderRecipeItem = ({ item }: { item: Recipe }) => {
        // Get the dynamic style based on tags
        const cardStyle = getCardStyleFromTags(item.tags);

        return (
            <TouchableOpacity style={styles.recipeCard} onPress={() => onView(item.id)}>
                {item.photoURL ? (
                    <Image source={{ uri: item.photoURL }} style={styles.recipeImage} />
                ) : (
                    // --- This is our new fallback view ---
                    <View style={[styles.recipeImagePlaceholder, { backgroundColor: cardStyle.backgroundColor }]}>
                        <Ionicons name={cardStyle.icon} size={60} color="rgba(255, 255, 255, 0.7)" />
                    </View>
                )}
                <Text style={styles.recipeName} numberOfLines={2}>{item.name}</Text>
            </TouchableOpacity>
        );
    };

    return (
        <View style={styles.carouselContainer}>
            <Text style={styles.sectionTitle}>{title}</Text>
            <FlatList
                data={recipes}
                horizontal
                showsHorizontalScrollIndicator={false}
                keyExtractor={(item) => item.id}
                contentContainerStyle={{ paddingRight: 16 }}
                renderItem={renderRecipeItem} // 👈 Use the new render function
            />
        </View>
    );
};

// --- New Component for the User Card ---
const UserCard = ({ creator }: { creator: Creator }) => (
    <TouchableOpacity style={styles.userCard}>
        <View style={styles.userCardHeader}>
            <Image source={{ uri: creator.photoURL }} style={styles.userAvatar} />
            <View style={styles.userInfo}>
                <Text style={styles.userName} numberOfLines={1}>{creator.displayName}</Text>
                <View style={styles.userStats}>
                    <Text style={styles.userStatText}>{creator.followers.toLocaleString()} followers</Text>
                    <Text style={styles.userStatSeparator}>•</Text>
                    <Text style={styles.userStatText}>{creator.recipeCount} recipes</Text>
                </View>
            </View>
        </View>
        <View style={styles.popularRecipe}>
            <Image source={{ uri: creator.popularRecipe.photoURL }} style={styles.popularRecipeImage} />
            <Text style={styles.popularRecipeText} numberOfLines={1}>{creator.popularRecipe.name}</Text>
        </View>
    </TouchableOpacity>
);

// --- New Component for the Creator Carousel ---
const CreatorCarousel = ({ title, creators }: { title: string; creators: Creator[] }) => (
    <View style={styles.carouselContainer}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <FlatList
            data={creators}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyExtractor={(item) => item.uid}
            contentContainerStyle={{ paddingRight: 16 }}
            renderItem={({ item }) => <UserCard creator={item} />}
        />
    </View>
);


export default function ExploreScreen() {
    const [searchQuery, setSearchQuery] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [exploreData, setExploreData] = useState<any>(null);
    const [recipeToViewId, setRecipeToViewId] = useState<string | null>(null);
    const [isFocused, setIsFocused] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);

    useFocusEffect(
        useCallback(() => {
            setIsFocused(true);
            return () => setIsFocused(false);
        }, [])
    );

    const fetchContent = useCallback(async () => {
        try {
            const content = await getExploreContent();
            // We are adding our mock data to the fetched content for now
            setExploreData({ ...content, featuredCreators });
        } catch (error) {
            console.error(error);
        }
    }, []); // Empty dependency array is now correct because featuredCreators is stable


    useEffect(() => {
        const initialLoad = async () => {
            setIsLoading(true);
            await fetchContent();
            setIsLoading(false);
        };
        initialLoad();
    }, [fetchContent]);
    
    const onRefresh = useCallback(async () => {
        setIsRefreshing(true);
        await fetchContent();
        setIsRefreshing(false);
    }, [fetchContent]);

    const handleSearch = () => {
        if (!searchQuery) return;
        console.log(`Searching for: ${searchQuery}`);
    };

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
                            <ScrollView 
                                showsVerticalScrollIndicator={false}
                                refreshControl={
                                    <RefreshControl
                                        refreshing={isRefreshing}
                                        onRefresh={onRefresh}
                                        tintColor="#333"
                                    />
                                }
                            >
                                {exploreData?.trending?.length > 0 && (
                                    <RecipeCarousel title="For You" recipes={exploreData.trending} onView={handleViewRecipe} />
                                )}
                                {exploreData?.featuredCreators?.length > 0 && (
                                    <CreatorCarousel title="Featured Creators" creators={exploreData.featuredCreators} />
                                )}
                                {exploreData?.newest?.length > 0 && (
                                    <RecipeCarousel title="Recent" recipes={exploreData.newest} onView={handleViewRecipe} />
                                )}
                            </ScrollView>
                        )}
                    </View>
                </View>
            </SafeAreaView>

            <ViewRecipeModal
                isVisible={!!recipeToViewId}
                onClose={() => setRecipeToViewId(null)}
                recipeId={recipeToViewId}
                isInCookbook={false}
                onCookbookUpdate={() => {}}
                onEdit={() => {}}
            />
        </>
    );
}

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
    // --- New Styles for User Card ---
    userCard: {
        width: 280,
        marginLeft: 16,
        backgroundColor: '#f8f9fa',
        borderRadius: 12,
        padding: 12,
        borderWidth: 1,
        borderColor: '#e9ecef'
    },
    userCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 10,
    },
    userAvatar: {
        width: 44,
        height: 44,
        borderRadius: 22,
        marginRight: 10,
    },
    userInfo: {
        flex: 1,
    },
    userName: {
        fontWeight: 'bold',
        fontSize: 16,
    },
    userStats: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 2,
    },
    userStatText: {
        fontSize: 12,
        color: '#6c757d',
    },
    userStatSeparator: {
        marginHorizontal: 4,
        color: '#6c757d',
    },
    popularRecipe: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'white',
        borderRadius: 8,
        padding: 8,
    },
    popularRecipeImage: {
        width: 32,
        height: 32,
        borderRadius: 6,
        marginRight: 8,
    },
    popularRecipeText: {
        flex: 1,
        fontSize: 13,
        fontWeight: '500',
    },
    // --- 👇 Add this new style ---
    recipeImagePlaceholder: {
        width: '100%',
        height: 150,
        borderRadius: 10,
        justifyContent: 'center',
        alignItems: 'center',
    },
});

