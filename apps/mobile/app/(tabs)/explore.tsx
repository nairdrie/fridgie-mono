import RecipeCard from '@/components/RecipeCard';
import AddEditRecipeModal from '@/components/AddEditRecipeModal';
import { useCookbook } from '@/context/CookbookContext';
import ViewRecipeModal from '@/components/ViewRecipeModal';
import { AmbientBackground, GlassPressable, GlassSurface, useGlassPreferences } from '@/components/ui/Glass';
import { Item, Meal, Recipe, UserSearchResult } from '@/types/types';
import { getExploreContent, searchAll } from '@/utils/api';
import { getCardStyleFromTags } from '@/utils/recipeStyling';
import { ink, inkMuted, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Platform, RefreshControl, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface Creator {
    uid: string;
    displayName: string;
    photoURL: string;
    followerCount: number;
    recipeCount: number;
    featuredRecipe?: { id: string; name: string; photoURL: string };
}

interface ExploreContent {
    trending?: Recipe[];
    newest?: Recipe[];
    featuredCreators?: Creator[];
}

function SectionHeading({ title, subtitle, icon }: { title: string; subtitle?: string; icon?: React.ComponentProps<typeof Ionicons>['name'] }) {
    return (
        <View style={styles.sectionHeading}>
            <View style={styles.sectionHeadingCopy}>
                <Text style={styles.sectionTitle}>{title}</Text>
                {!!subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}
            </View>
            {!!icon && <View style={styles.sectionIcon}><Ionicons name={icon} size={19} color={primary} /></View>}
        </View>
    );
}

function RecipeCarousel({ title, subtitle, recipes, onView, featured = false }: {
    title: string; subtitle: string; recipes: Recipe[]; onView: (id: string) => void; featured?: boolean;
}) {
    const { width } = useWindowDimensions();
    const cardWidth = Math.min(width - 64, featured ? 330 : 260);
    return (
        <View style={styles.carouselContainer}>
            <SectionHeading title={title} subtitle={subtitle} icon={featured ? 'sparkles-outline' : 'time-outline'} />
            <FlatList
                data={recipes}
                horizontal
                showsHorizontalScrollIndicator={false}
                keyExtractor={(recipe) => `${title}-${recipe.id}`}
                contentContainerStyle={styles.carouselContent}
                snapToInterval={cardWidth + 14}
                decelerationRate="fast"
                renderItem={({ item }) => (
                    <GlassPressable
                        style={[styles.recipeCard, { width: cardWidth, height: featured ? 344 : 292 }]}
                        onPress={() => onView(item.id)}
                        accessibilityRole="button"
                        accessibilityLabel={`View ${item.name}`}
                    >
                        {item.photoURL ? <Image source={{ uri: item.photoURL }} style={styles.recipeImage} /> : (
                            <View style={styles.recipeImagePlaceholder}>
                                <View style={styles.placeholderOrb} />
                                <Ionicons name={getCardStyleFromTags(item.tags).icon} size={84} color="#608875" />
                            </View>
                        )}
                        <GlassSurface style={styles.recipeBadge} intensity={60}>
                            <Ionicons name="restaurant-outline" size={12} color={ink} />
                            <Text style={styles.recipeBadgeText}>{item.category || 'Recipe inspiration'}</Text>
                        </GlassSurface>
                        <GlassSurface style={styles.recipeCaption} intensity={75}>
                            <View style={styles.recipeCaptionCopy}>
                                <Text style={styles.recipeName} numberOfLines={2}>{item.name}</Text>
                                <Text style={styles.recipeByline} numberOfLines={1}>
                                    {item.authorName ? `By ${item.authorName}` : `${item.ingredients?.length || 0} ingredients`}
                                </Text>
                            </View>
                            <View style={styles.recipeArrow}><Ionicons name="arrow-up-outline" size={20} color={ink} style={{ transform: [{ rotate: '45deg' }] }} /></View>
                        </GlassSurface>
                    </GlassPressable>
                )}
            />
        </View>
    );
}

function UserCard({ creator, isSearchResult = false }: { creator: Creator; isSearchResult?: boolean }) {
    const router = useRouter();
    return (
        <GlassPressable
            style={[styles.userCard, isSearchResult && styles.searchResultUserCard]}
            onPress={() => router.push({ pathname: '/profile/[uid]', params: { uid: creator.uid } })}
            accessibilityRole="button"
            accessibilityLabel={`View ${creator.displayName}'s profile`}
        >
            <View style={styles.userCardHeader}>
                {creator.photoURL ? <Image source={{ uri: creator.photoURL }} style={styles.userAvatar} /> : (
                    <View style={[styles.userAvatar, styles.avatarPlaceholder]}><Text style={styles.avatarInitial}>{creator.displayName?.charAt(0).toUpperCase() || '?'}</Text></View>
                )}
                <View style={styles.userInfo}>
                    <Text style={styles.userName} numberOfLines={1}>{creator.displayName}</Text>
                    <Text style={styles.userStatText}>{creator.recipeCount} recipes · {creator.followerCount} followers</Text>
                </View>
                <Ionicons name="chevron-forward" size={17} color={inkMuted} />
            </View>
            {!isSearchResult && creator.featuredRecipe && (
                <View style={styles.popularRecipe}>
                    {creator.featuredRecipe.photoURL ? <Image source={{ uri: creator.featuredRecipe.photoURL }} style={styles.popularRecipeImage} /> : <View style={[styles.popularRecipeImage, styles.avatarPlaceholder]}><Ionicons name="restaurant-outline" size={20} color={primary} /></View>}
                    <View style={{ flex: 1 }}>
                        <Text style={styles.popularRecipeLabel}>FROM THEIR KITCHEN</Text>
                        <Text style={styles.popularRecipeText} numberOfLines={1}>{creator.featuredRecipe.name}</Text>
                    </View>
                </View>
            )}
        </GlassPressable>
    );
}

export default function ExploreScreen() {
    const { addRecipe } = useCookbook();
    const { reduceMotion } = useGlassPreferences();
    const [searchQuery, setSearchQuery] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [exploreData, setExploreData] = useState<ExploreContent | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [recipeToViewId, setRecipeToViewId] = useState<string | null>(null);
    const [recipeToEdit, setRecipeToEdit] = useState<Recipe | null>(null);
    const [isEditorVisible, setEditorVisible] = useState(false);
    const pendingEdit = useRef<Recipe | null>(null);
    const returnToRecipe = useRef<string | null>(null);
    const [isFocused, setIsFocused] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [searchResults, setSearchResults] = useState<{ recipes: Recipe[]; users: UserSearchResult[] }>({ recipes: [], users: [] });
    const [isSearching, setIsSearching] = useState(false);
    const [searchError, setSearchError] = useState(false);
    const searching = searchQuery.trim().length > 0;

    useFocusEffect(useCallback(() => {
        setIsFocused(true);
        return () => setIsFocused(false);
    }, []));

    const fetchContent = useCallback(async () => {
        try {
            const content = await getExploreContent();
            setExploreData(content);
            setLoadError(false);
        } catch (error) {
            console.error('Could not load inspiration:', error);
            setLoadError(true);
        }
    }, []);

    useEffect(() => {
        let active = true;
        fetchContent().finally(() => { if (active) setIsLoading(false); });
        return () => { active = false; };
    }, [fetchContent]);

    useEffect(() => {
        let active = true;
        if (!searchQuery.trim()) {
            setSearchResults({ recipes: [], users: [] });
            setIsSearching(false);
            setSearchError(false);
            return;
        }
        setIsSearching(true);
        setSearchError(false);
        const timer = setTimeout(async () => {
            try {
                const results = await searchAll(searchQuery.trim());
                if (active) setSearchResults(results);
            } catch (error) {
                console.error('Search failed:', error);
                if (active) {
                    setSearchResults({ recipes: [], users: [] });
                    setSearchError(true);
                }
            } finally {
                if (active) setIsSearching(false);
            }
        }, 300);
        return () => { active = false; clearTimeout(timer); };
    }, [searchQuery]);

    const onRefresh = useCallback(async () => {
        setIsRefreshing(true);
        await fetchContent();
        setIsRefreshing(false);
    }, [fetchContent]);
    const handleEditRecipe = (recipe: Recipe) => {
        pendingEdit.current = recipe;
        returnToRecipe.current = recipe.id;
        setRecipeToViewId(null);
    };

    // iOS must finish dismissing one native sheet before presenting the next.
    const finishDetailDismiss = useCallback(() => {
        if (!pendingEdit.current) return;
        setRecipeToEdit(pendingEdit.current);
        pendingEdit.current = null;
        setEditorVisible(true);
    }, []);

    const finishEditorDismiss = useCallback(() => {
        if (!recipeToEdit) return;
        const recipeId = returnToRecipe.current ?? recipeToEdit.id;
        returnToRecipe.current = null;
        setRecipeToEdit(null);
        setRecipeToViewId(recipeId);
    }, [recipeToEdit]);

    // Native onDismiss is iOS-only. Other platforms finish the same handoff
    // after their slide transition; cleanup prevents a stale presentation.
    useEffect(() => {
        if (Platform.OS === 'ios' || recipeToViewId || !pendingEdit.current) return;
        const timer = setTimeout(finishDetailDismiss, reduceMotion ? 0 : 350);
        return () => clearTimeout(timer);
    }, [recipeToViewId, finishDetailDismiss, reduceMotion]);

    useEffect(() => {
        if (Platform.OS === 'ios' || isEditorVisible || !recipeToEdit) return;
        const timer = setTimeout(finishEditorDismiss, reduceMotion ? 0 : 350);
        return () => clearTimeout(timer);
    }, [isEditorVisible, recipeToEdit, finishEditorDismiss, reduceMotion]);

    const handleRecipeSaved = async (_meal: Meal | null, _items: Item[], savedRecipe: Recipe) => {
        returnToRecipe.current = savedRecipe.id;
        if (recipeToEdit && recipeToEdit.id !== savedRecipe.id) {
            try {
                await addRecipe(savedRecipe.id);
            } catch (error) {
                console.error('Failed to file the copied recipe:', error);
                Alert.alert('Saved, but not filed', 'Your copy was saved but could not be added to your cookbook. You can add it from the recipe.');
            }
        }
        void fetchContent();
    };

    const hasContent = !!(exploreData?.trending?.length || exploreData?.newest?.length || exploreData?.featuredCreators?.length);

    return (
        <AmbientBackground>
            {isFocused && <StatusBar style="dark" />}
            <SafeAreaView style={styles.pageContainer} edges={['top']}>
                <View style={styles.headerContent}>
                    <View>
                        <Text style={styles.eyebrow}>A LITTLE INSPIRATION</Text>
                        <Text style={styles.pageTitle}>Discover</Text>
                    </View>
                    <GlassSurface style={styles.headerEmblem} intensity={65}><Ionicons name="sparkles" size={24} color={primary} /></GlassSurface>
                </View>
                <GlassSurface style={styles.searchContainer} intensity={65}>
                    <Ionicons name="search-outline" size={21} color={primary} />
                    <TextInput
                        style={styles.searchInput}
                        placeholder="Recipes, people, something delicious…"
                        placeholderTextColor={inkMuted}
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        returnKeyType="search"
                        autoCorrect={false}
                        accessibilityLabel="Search recipes and people"
                    />
                    {searchQuery.length > 0 && <GlassPressable style={styles.clearSearch} onPress={() => setSearchQuery('')} accessibilityRole="button" accessibilityLabel="Clear search"><Ionicons name="close" size={17} color={inkMuted} /></GlassPressable>}
                </GlassSurface>
                {isLoading || (searching && isSearching) ? (
                    <View style={styles.loading}><ActivityIndicator size="large" color={primary} /><Text style={styles.loadingText}>{searching ? 'Finding something delicious…' : 'Fresh inspiration is on its way…'}</Text></View>
                ) : (
                    <ScrollView
                        showsVerticalScrollIndicator={false}
                        contentContainerStyle={styles.scrollContent}
                        keyboardShouldPersistTaps="handled"
                        keyboardDismissMode="on-drag"
                        refreshControl={!searching ? <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={primary} /> : undefined}
                    >
                        {searching ? (
                            <>
                                {searchResults.users.length > 0 && <>
                                    <SectionHeading title="People" subtitle="A new kitchen to get to know" />
                                    {searchResults.users.map(user => <View key={user.objectID} style={styles.searchResultContainer}><UserCard isSearchResult creator={{ uid: user.objectID, displayName: user.displayName, photoURL: user.photoURL, followerCount: user.followerCount || 0, recipeCount: user.recipeCount || 0 }} /></View>)}
                                </>}
                                {searchResults.recipes.length > 0 && <>
                                    <SectionHeading title="Recipes" subtitle={`${searchResults.recipes.length} delicious possibilities`} />
                                    {searchResults.recipes.map(recipe => <View key={recipe.id} style={styles.searchResultContainer}><RecipeCard recipe={recipe} onView={setRecipeToViewId} onAddToMealPlan={() => {}} /></View>)}
                                </>}
                                {!searchResults.recipes.length && !searchResults.users.length && <View style={styles.emptyState}>
                                    <View style={styles.emptyIcon}><Ionicons name={searchError ? 'cloud-offline-outline' : 'search-outline'} size={32} color={primary} /></View>
                                    <Text style={styles.emptyTitle}>{searchError ? 'Search is taking a break' : 'Something else on your mind?'}</Text>
                                    <Text style={styles.emptyText}>{searchError ? 'Check your connection and try searching again.' : `No matches for “${searchQuery}”. Try an ingredient, dish, or creator.`}</Text>
                                </View>}
                            </>
                        ) : (
                            <>
                                {!!exploreData?.trending?.length && <RecipeCarousel title="Worth staying in for" subtitle="Your next favourite starts here" recipes={exploreData.trending} onView={setRecipeToViewId} featured />}
                                {!!exploreData?.featuredCreators?.length && <View style={styles.carouselContainer}>
                                    <SectionHeading title="Meet the cooks" subtitle="Good food. Great company." icon="people-outline" />
                                    <FlatList data={exploreData.featuredCreators} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.carouselContent} keyExtractor={creator => creator.uid} renderItem={({ item }) => <UserCard creator={item} />} />
                                </View>}
                                {!!exploreData?.newest?.length && <RecipeCarousel title="Fresh from the kitchen" subtitle="New recipes to fall in love with" recipes={exploreData.newest} onView={setRecipeToViewId} />}
                                {!hasContent && <View style={styles.emptyState}>
                                    <View style={styles.emptyIcon}><Ionicons name={loadError ? 'cloud-offline-outline' : 'restaurant-outline'} size={34} color={primary} /></View>
                                    <Text style={styles.emptyTitle}>{loadError ? 'A little connection hiccup' : 'A world of good food awaits'}</Text>
                                    <Text style={styles.emptyText}>{loadError ? 'Your inspiration will be here when you reconnect.' : 'Find a favourite recipe or a cook you love using the search above.'}</Text>
                                    <GlassPressable style={styles.retryButton} onPress={onRefresh} accessibilityRole="button" accessibilityLabel="Refresh recipe inspiration"><Ionicons name="refresh-outline" size={18} color={primary} /><Text style={styles.retryText}>Refresh inspiration</Text></GlassPressable>
                                </View>}
                            </>
                        )}
                    </ScrollView>
                )}
            </SafeAreaView>
            <ViewRecipeModal
                isVisible={!!recipeToViewId}
                onClose={() => setRecipeToViewId(null)}
                onDismiss={finishDetailDismiss}
                recipeId={recipeToViewId}
                onEdit={handleEditRecipe}
            />
            <AddEditRecipeModal
                isVisible={isEditorVisible}
                onClose={() => setEditorVisible(false)}
                onDismiss={finishEditorDismiss}
                mealForRecipe={null}
                recipeToEdit={recipeToEdit}
                onRecipeSave={handleRecipeSaved}
            />
        </AmbientBackground>
    );
}

const styles = StyleSheet.create({
    pageContainer: { flex: 1 },
    headerContent: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 20, paddingBottom: 22 },
    eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 2.1, color: inkMuted, marginBottom: 7 },
    pageTitle: { fontSize: 39, fontWeight: '700', letterSpacing: -1.8, color: ink },
    headerEmblem: { width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center' },
    searchContainer: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 22, paddingHorizontal: 17, borderRadius: 25, minHeight: 54, gap: 10, marginBottom: 28 },
    searchInput: { flex: 1, minHeight: 54, fontSize: 14, color: ink, paddingVertical: 12 },
    clearSearch: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 15 },
    scrollContent: { paddingBottom: 130 },
    sectionHeading: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, marginBottom: 17 },
    sectionHeadingCopy: { flex: 1 },
    sectionTitle: { fontSize: 23, fontWeight: '700', letterSpacing: -0.7, color: ink },
    sectionSubtitle: { fontSize: 13, color: inkMuted, marginTop: 4 },
    sectionIcon: { width: 37, height: 37, borderRadius: 19, backgroundColor: '#E5ECE2', alignItems: 'center', justifyContent: 'center' },
    carouselContainer: { marginBottom: 30 },
    carouselContent: { paddingHorizontal: 22, gap: 14, paddingBottom: 8 },
    recipeCard: { borderRadius: 29, overflow: 'hidden', backgroundColor: '#DCE9DB' },
    recipeImage: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%', resizeMode: 'cover' },
    recipeImagePlaceholder: { ...StyleSheet.absoluteFillObject, backgroundColor: '#DCE9DB', alignItems: 'center', justifyContent: 'center', paddingBottom: 70 },
    placeholderOrb: { position: 'absolute', width: 220, height: 220, borderRadius: 110, top: -35, right: -45, backgroundColor: '#EACCB9' },
    recipeBadge: { position: 'absolute', top: 15, left: 15, maxWidth: '85%', borderRadius: 15, paddingHorizontal: 11, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 5 },
    recipeBadgeText: { fontSize: 10, fontWeight: '700', color: ink, flexShrink: 1 },
    recipeCaption: { position: 'absolute', bottom: 10, left: 10, right: 10, padding: 16, borderRadius: 22, flexDirection: 'row', alignItems: 'center', gap: 8 },
    recipeCaptionCopy: { flex: 1 },
    recipeName: { fontSize: 21, lineHeight: 25, fontWeight: '700', letterSpacing: -0.6, color: ink },
    recipeByline: { fontSize: 11, fontWeight: '500', color: '#4F675B', marginTop: 7 },
    recipeArrow: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.6)', alignItems: 'center', justifyContent: 'center' },
    userCard: { width: 300, padding: 17, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 1, borderColor: '#FFF' },
    searchResultUserCard: { width: '100%' },
    userCardHeader: { flexDirection: 'row', alignItems: 'center' },
    userAvatar: { width: 48, height: 48, borderRadius: 24, marginRight: 12, backgroundColor: '#DCEDE2' },
    avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#DCEDE2' },
    avatarInitial: { fontSize: 21, fontWeight: '600', color: primary },
    userInfo: { flex: 1 },
    userName: { fontSize: 17, fontWeight: '700', letterSpacing: -0.4, color: ink },
    userStatText: { fontSize: 11, color: inkMuted, marginTop: 5 },
    popularRecipe: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F0F3EB', borderRadius: 17, marginTop: 16, padding: 8, gap: 10 },
    popularRecipeImage: { width: 42, height: 42, borderRadius: 12 },
    popularRecipeLabel: { fontSize: 8, fontWeight: '700', letterSpacing: 1, color: inkMuted, marginBottom: 4 },
    popularRecipeText: { fontSize: 12, fontWeight: '600', color: ink },
    searchResultContainer: { paddingHorizontal: 22, marginBottom: 12 },
    loading: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 100, gap: 18 },
    loadingText: { color: inkMuted, fontSize: 14 },
    emptyState: { paddingHorizontal: 38, paddingTop: 35, alignItems: 'center' },
    emptyIcon: { width: 80, height: 80, borderRadius: 28, backgroundColor: '#E0ECE0', alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
    emptyTitle: { fontSize: 24, fontWeight: '700', letterSpacing: -0.8, color: ink, textAlign: 'center' },
    emptyText: { fontSize: 15, lineHeight: 23, color: inkMuted, textAlign: 'center', marginTop: 10 },
    retryButton: { marginTop: 24, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 24, backgroundColor: '#DCEDE2', paddingHorizontal: 20, paddingVertical: 14 },
    retryText: { fontSize: 14, fontWeight: '600', color: primary },
});
