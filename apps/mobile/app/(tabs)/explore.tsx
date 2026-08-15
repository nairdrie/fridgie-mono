import Logo from '@/components/Logo';
import RecipeCard from '@/components/RecipeCard';
import ViewRecipeModal from '@/components/ViewRecipeModal';
import { Recipe, UserSearchResult } from '@/types/types';
import { getExploreContent, searchAll } from '@/utils/api';
import { getCardStyleFromTags } from '@/utils/recipeStyling';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// TODO: when adding a recipe to meal plan from viewrecipemodal its not there right away. 

// --- Types for our new Creator section ---
interface Creator {
    uid: string;
    displayName: string;
    photoURL: string;
    followerCount: number;
    recipeCount: number;
    featuredRecipe?: {
        id: string;
        name: string;
        photoURL: string;
    };
}

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
                keyExtractor={(item) => `${title}-${item.id}`}
                contentContainerStyle={{ paddingRight: 16 }}
                renderItem={renderRecipeItem} // 👈 Use the new render function
            />
        </View>
    );
};

// --- New Component for the User Card ---
const UserCard = ({ creator, isSearchResult }: { creator: Creator, isSearchResult?: boolean }) => {
    const router = useRouter();

    const handlePress = () => {
        router.push({
            pathname: '/profile/[uid]',
            params: { uid: creator.uid },
        });
    };

    return (
        <TouchableOpacity
            // Apply the base style, and conditionally add the search result style
            style={[styles.userCard, isSearchResult && styles.searchResultUserCard]}
            onPress={handlePress}
        >
            <View style={styles.userCardHeader}>
                <Image source={{ uri: creator.photoURL }} style={styles.userAvatar} />
                <View style={styles.userInfo}>
                    <Text style={styles.userName} numberOfLines={1}>{creator.displayName}</Text>
                    <View style={styles.userStats}>
                        <Ionicons name="person-outline" size={14} color="#495057" />
                        <Text style={styles.userStatText}>{creator.followerCount} followers</Text>
                        <Text style={styles.userStatSeparator}>•</Text>
                        <Ionicons name="restaurant-outline" size={14} color="#495057" />
                        <Text style={styles.userStatText}>{creator.recipeCount} recipes</Text>
                    </View>
                </View>
            </View>
            {/* Only show the featured recipe if it's NOT a search result */}
            {!isSearchResult && creator.featuredRecipe && (
                <View style={styles.popularRecipe}>
                    <View style={styles.popularRecipeContent}>
                        <Image source={{ uri: creator.featuredRecipe.photoURL }} style={styles.popularRecipeImage} />
                        <Text style={styles.popularRecipeText} numberOfLines={1}>{creator.featuredRecipe.name}</Text>
                    </View>
                </View>
            )}
        </TouchableOpacity>
    );
};


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
    const [searchResults, setSearchResults] = useState<{ recipes: Recipe[]; users: UserSearchResult[] }>({ recipes: [], users: [] });
    const [isSearching, setIsSearching] = useState(false);

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
            setExploreData({ ...content });
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

     useEffect(() => {
        if (searchQuery.trim() === '') {
            setSearchResults({ recipes: [], users: [] });
            setIsSearching(false);
            return;
        }

        setIsSearching(true);
        const timer = setTimeout(async () => {
            try {
                // Use the new searchAll function
                const results = await searchAll(searchQuery);
                setSearchResults(results);
            } catch (error) {
                console.error("Search failed:", error);
                setSearchResults({ recipes: [], users: [] });
            } finally {
                setIsSearching(false);
            }
        }, 300);

        return () => clearTimeout(timer);
    }, [searchQuery]);
    
    const onRefresh = useCallback(async () => {
        setIsRefreshing(true);
        await fetchContent();
        setIsRefreshing(false);
    }, [fetchContent]);

    const handleViewRecipe = (recipeId: string) => {
        console.log("CLICKED VIEW RECIPE", recipeId)
        setRecipeToViewId(recipeId);
    };

    const renderSearchResults = () => {
        const hasNoResults = searchResults.recipes.length === 0 && searchResults.users.length === 0;

        if (isSearching) {
            return <ActivityIndicator size="large" style={{ marginTop: 50 }} />;
        }

        if (hasNoResults) {
            return <Text style={styles.noResultsText}>No results found for "{searchQuery}"</Text>;
        }

        return (
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 20 }}>
                {/* Users Section */}
                {searchResults.users.length > 0 && (
                    <View>
                        <Text style={styles.sectionTitle}>People</Text>
                        {searchResults.users.map(user => (
                            <View key={user.objectID} style={styles.searchResultUserContainer}>
                                {/* The UserCard component here is the one you defined above */}
                                <UserCard isSearchResult={true} creator={{ 
                                    uid: user.objectID,
                                    displayName: user.displayName,
                                    photoURL: user.photoURL,
                                    // Add dummy data for fields not in search result
                                    followerCount: user.followerCount || 0, 
                                    recipeCount: user.recipeCount || 0,
                                }} />
                            </View>
                        ))}
                    </View>
                )}

                {/* Recipes Section */}
                {searchResults.recipes.length > 0 && (
                    <View>
                        <Text style={styles.sectionTitle}>Recipes</Text>
                        {searchResults.recipes.map(recipe => (
                             <View key={recipe.id} style={styles.searchResultItemContainer}>
                                <RecipeCard
                                    recipe={recipe}
                                    onView={handleViewRecipe}
                                    onAddToMealPlan={() => {}}
                                />
                            </View>
                        ))}
                    </View>
                )}
            </ScrollView>
        );
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
                                returnKeyType="search"
                            />
                        </View>
                    </View>

                    <View style={styles.contentCard}>
                        {isLoading ? (
                            <ActivityIndicator size="large" style={{ marginTop: 50 }} />
                        ) : (
                            searchQuery.trim().length > 0 ? (
                                renderSearchResults()
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
                            )
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
    noResultsText: {
        textAlign: 'center',
        marginTop: 50,
        fontSize: 16,
        color: '#6c757d',
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
        width: 300,
        marginLeft: 16,
        backgroundColor: '#fdfdfd',
        borderRadius: 16,
        padding: 16,
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
        elevation: 5,
        marginTop: 6,
        marginBottom: 6,
    },

    // ✨ REMOVED the old `fullWidthUserCard` style

    // ✨ ADDED the new style for the search result variant
    searchResultUserCard: {
        width: '100%',
        marginLeft: 0,
        marginTop: 0,
        marginBottom: 0,
        // Make it flat
        shadowOpacity: 0,
        elevation: 0,
        // Use a simple border instead of a shadow
        borderWidth: 1,
        borderColor: '#e9ecef',
        // Use a simpler background
        backgroundColor: '#fff',
        // Make it slightly more compact
        padding: 12,
    },
    // ... (the rest of your styles remain the same)

    searchResultUserContainer: {
        paddingHorizontal: 16,
        marginBottom: 12, // Reduced margin slightly for a tighter list
    },
    fullWidthUserCard: {
        width: '100%',
        marginLeft: 0
    },
    userCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    userAvatar: {
        width: 50, // ✨ Change: Larger avatar
        height: 50, // ✨ Change: Larger avatar
        borderRadius: 25, // ✨ Change: Keep it circular
        marginRight: 12, // ✨ Change: Slightly more space
    },
    userInfo: {
        flex: 1,
    },
    userName: {
        fontWeight: 'bold',
        fontSize: 18, // ✨ Change: Larger name for better hierarchy
    },
    userStats: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 4, // ✨ Change: More space below the name
    },
    userStatText: {
        fontSize: 13, // ✨ Change: Slightly larger and more readable
        color: '#495057', // ✨ Change: Darker text for better contrast
        marginLeft: 4, // ✨ Change: Space after the icon
    },
    userStatSeparator: {
        marginHorizontal: 6, // ✨ Change: A bit more separation
        color: '#adb5bd',
    },
    popularRecipe: {
        // ✨ Change: This is now a container for the title and content
        marginTop: 16,
    },
    popularRecipeTitle: {
        // ✨ New: Style for the "Featured Recipe" title
        fontSize: 12,
        fontWeight: '600',
        color: '#6c757d',
        textTransform: 'uppercase',
        marginBottom: 8,
    },
    popularRecipeContent: {
        // ✨ New: A wrapper for the actual recipe content
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'white',
        borderRadius: 10,
        padding: 8,
        borderWidth: 1,
        borderColor: '#e2e5e7ff',
    },
    popularRecipeImage: {
        width: 36, // ✨ Change: Slightly larger image
        height: 36, // ✨ Change: Slightly larger image
        borderRadius: 8, // ✨ Change: More rounded
        marginRight: 10,
    },
    popularRecipeText: {
        flex: 1,
        fontSize: 14, // ✨ Change: Larger for readability
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
    searchResultItemContainer: {
        paddingHorizontal: 16,
    },
});

