import AddEditRecipeModal from '@/components/AddEditRecipeModal';
import RecipeCard from '@/components/RecipeCard';
import ViewRecipeModal from '@/components/ViewRecipeModal';
import { DiscoverCreatorCard, discoveryAccents, FeatureRecipeCard, RecipeGrid } from '@/components/discover/DiscoverCards';
import { BrandWordmark } from '@/components/ui/Brand';
import { AmbientBackground, GlassPressable, GlassSurface, useGlassPreferences } from '@/components/ui/Glass';
import { useCookbook } from '@/context/CookbookContext';
import type { ExploreCollection, ExploreContent, Item, Meal, Recipe, UserSearchResult } from '@/types/types';
import { getExploreContent, searchAll } from '@/utils/api';
import { discoverCollections, discoverEditionLabel, discoverRecipes, surpriseRecipe } from '@/utils/discover';
import { ink, inkMuted, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

function SectionHeading({ title, subtitle, onSeeAll }: { title: string; subtitle?: string; onSeeAll?: () => void }) {
    return <View style={styles.sectionHeading}><View style={{ flex: 1 }}><Text style={styles.sectionTitle}>{title}</Text>{!!subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}</View>{onSeeAll && <GlassPressable style={styles.seeAll} onPress={onSeeAll} accessibilityLabel={`See all ${title} recipes`}><Text style={styles.seeAllText}>See all</Text><Ionicons name="arrow-forward" size={13} color={primary} /></GlassPressable>}</View>;
}

export default function ExploreScreen() {
    const router = useRouter();
    const { addRecipe } = useCookbook();
    const { reduceMotion } = useGlassPreferences();
    const [searchQuery, setSearchQuery] = useState('');
    const [topic, setTopic] = useState<string | null>(null);
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
    const [searchAttempt, setSearchAttempt] = useState(0);
    const mounted = useRef(true);
    const fetchInFlight = useRef<Promise<void> | null>(null);
    const scroll = useRef<ScrollView>(null);
    const lastOpenedRecipe = useRef<string | null>(null);
    const searching = searchQuery.trim().length > 0;
    const pauseRefresh = useRef(false);
    pauseRefresh.current = searching || !!recipeToViewId || isEditorVisible;

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const fetchContent = useCallback((): Promise<void> => {
        if (fetchInFlight.current) return fetchInFlight.current;
        const task = (async () => {
            try {
                const content = await getExploreContent();
                if (!mounted.current) return;
                setExploreData(content);
                setLoadError(false);
            } catch (error) {
                if (mounted.current) setLoadError(true);
                console.error('Could not load inspiration:', error);
            } finally {
                if (mounted.current) setIsLoading(false);
            }
        })();
        fetchInFlight.current = task;
        void task.finally(() => { if (fetchInFlight.current === task) fetchInFlight.current = null; });
        return task;
    }, []);

    useFocusEffect(useCallback(() => {
        setIsFocused(true);
        void fetchContent();
        // Only the visible tab refreshes. A new edition comes from the server;
        // recipe cards never shuffle themselves or manufacture activity.
        const timer = setInterval(() => {
            if (AppState.currentState === 'active' && !pauseRefresh.current) void fetchContent();
        }, 5 * 60_000);
        const subscription = AppState.addEventListener('change', state => {
            if (state === 'active' && !pauseRefresh.current) void fetchContent();
        });
        return () => { setIsFocused(false); clearInterval(timer); subscription.remove(); };
    }, [fetchContent]));

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
                if (active) { setSearchResults({ recipes: [], users: [] }); setSearchError(true); }
            } finally {
                if (active) setIsSearching(false);
            }
        }, 300);
        return () => { active = false; clearTimeout(timer); };
    }, [searchQuery, searchAttempt]);

    const onRefresh = useCallback(async () => {
        setIsRefreshing(true);
        await fetchContent();
        if (mounted.current) setIsRefreshing(false);
    }, [fetchContent]);

    const openRecipe = useCallback((id: string) => {
        lastOpenedRecipe.current = id;
        setRecipeToViewId(id);
    }, []);
    const handleEditRecipe = (recipe: Recipe) => {
        pendingEdit.current = recipe;
        returnToRecipe.current = recipe.id;
        setRecipeToViewId(null);
    };
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

    // Keep native sheet handoffs intact when editing an existing recipe.
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
        if (recipeToEdit && recipeToEdit.id !== savedRecipe.id) await addRecipe(savedRecipe.id);
        returnToRecipe.current = savedRecipe.id;
        void fetchContent();
    };

    const allRecipes = useMemo(() => discoverRecipes(exploreData), [exploreData]);
    const collections = useMemo(() => discoverCollections(exploreData), [exploreData]);
    const activeCollection = collections.find(collection => collection.id === topic);
    const hero = exploreData?.heroRecipe ?? allRecipes[0];
    const creators = exploreData?.featuredCreators ?? [];
    const hasContent = allRecipes.length > 0 || creators.length > 0;
    const chooseTopic = (id: string | null) => { setTopic(id); scroll.current?.scrollTo({ y: 0, animated: !reduceMotion }); };
    const surprise = () => {
        const recipe = surpriseRecipe(activeCollection?.recipes ?? allRecipes, lastOpenedRecipe.current);
        if (recipe) openRecipe(recipe.id);
    };
    const renderCreators = () => creators.length > 0 && <View style={styles.creatorSection}>
        <View style={styles.inset}><SectionHeading title="Find your kitchen people" subtitle={creators.some(creator => creator.profileKind === 'curated') ? 'Fictional kitchens. Fresh ideas from Fridgie.' : undefined} /></View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.creatorRail} snapToInterval={271} decelerationRate="fast">
            {creators.map(creator => <DiscoverCreatorCard key={creator.uid} creator={creator} onPress={() => router.push({ pathname: '/profile/[uid]', params: { uid: creator.uid } })} />)}
        </ScrollView>
    </View>;
    const renderCollection = (collection: ExploreCollection, index: number) => {
        const recipes = collection.recipes.filter(recipe => recipe.id !== hero?.id).slice(0, 4);
        if (!recipes.length) return null;
        return <Animated.View key={collection.id} entering={FadeInDown.delay(Math.min(index, 3) * 70).duration(450).reduceMotion(ReduceMotion.System)} style={styles.collection}>
            <SectionHeading title={collection.title} subtitle={collection.subtitle} onSeeAll={collection.recipes.length > recipes.length ? () => chooseTopic(collection.id) : undefined} />
            <RecipeGrid recipes={recipes} accent={collection.accent} onView={openRecipe} />
        </Animated.View>;
    };

    return <AmbientBackground>
        {isFocused && <StatusBar style="dark" />}
        <SafeAreaView style={styles.page} edges={['top']}>
            <View style={styles.header}>
                <BrandWordmark height={25} />
                <GlassSurface style={styles.search} intensity={65}><Ionicons name="search-outline" size={19} color={primary} /><TextInput style={styles.searchInput} placeholder="Search recipes & kitchens" placeholderTextColor={inkMuted} value={searchQuery} onChangeText={setSearchQuery} returnKeyType="search" autoCorrect={false} accessibilityLabel="Search recipes and creators" />{searchQuery.length > 0 && <GlassPressable style={styles.clearSearch} onPress={() => setSearchQuery('')} accessibilityLabel="Clear search"><Ionicons name="close" size={17} color={inkMuted} /></GlassPressable>}</GlassSurface>
            </View>
            {!searching && collections.length > 0 && <View style={styles.topicsContainer}><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.topics}>
                <GlassPressable style={[styles.topic, !activeCollection && styles.topicSelected]} onPress={() => chooseTopic(null)} accessibilityLabel="Show all recipe collections" accessibilityState={{ selected: !activeCollection }}><Ionicons name="grid-outline" size={13} color={!activeCollection ? '#FFF' : primary} /><Text style={[styles.topicText, !activeCollection && styles.topicTextSelected]}>All</Text></GlassPressable>
                {collections.map(collection => <GlassPressable key={collection.id} style={[styles.topic, activeCollection?.id === collection.id && styles.topicSelected]} onPress={() => chooseTopic(collection.id)} accessibilityLabel={`Browse ${collection.title}`} accessibilityState={{ selected: activeCollection?.id === collection.id }}><View style={[styles.topicDot, { backgroundColor: discoveryAccents[collection.accent].detail }]} /><Text style={[styles.topicText, activeCollection?.id === collection.id && styles.topicTextSelected]}>{collection.title}</Text></GlassPressable>)}
            </ScrollView></View>}
            {isLoading || (searching && isSearching) ? <View style={styles.loading}><ActivityIndicator size="large" color={primary} /><Text style={styles.loadingText}>{searching ? 'Finding something delicious…' : 'Opening today’s menu…'}</Text></View> : <ScrollView ref={scroll} showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" refreshControl={!searching ? <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={primary} /> : undefined}>
                {searching ? <View style={styles.inset}>
                    {searchResults.users.length > 0 && <><SectionHeading title="Kitchens" />{searchResults.users.map(user => <View key={user.objectID} style={{ marginBottom: 12 }}><DiscoverCreatorCard fullWidth creator={{ ...user, uid: user.objectID, followerCount: user.followerCount ?? 0, recipeCount: user.recipeCount ?? 0 }} onPress={() => router.push({ pathname: '/profile/[uid]', params: { uid: user.objectID } })} /></View>)}</>}
                    {searchResults.recipes.length > 0 && <><SectionHeading title="Recipes" subtitle={`${searchResults.recipes.length} to explore`} />{searchResults.recipes.map(recipe => <RecipeCard key={recipe.id} recipe={recipe} onView={openRecipe} onAddToMealPlan={() => {}} />)}</>}
                    {!searchResults.recipes.length && !searchResults.users.length && <View style={styles.empty}><Ionicons name={searchError ? 'cloud-offline-outline' : 'search-outline'} size={32} color={primary} /><Text style={styles.emptyTitle}>{searchError ? 'Search couldn’t connect' : 'Nothing on the menu yet'}</Text><Text style={styles.emptyText}>{searchError ? 'Try again when your connection is ready.' : `No matches for “${searchQuery}”. Try a dish, ingredient, or creator.`}</Text>{searchError && <GlassPressable style={styles.retry} onPress={() => setSearchAttempt(attempt => attempt + 1)}><Text style={styles.retryText}>Try again</Text></GlassPressable>}</View>}
                </View> : <>
                    {loadError && hasContent && <GlassPressable style={styles.refreshNotice} onPress={onRefresh}><Ionicons name="cloud-offline-outline" size={16} color={inkMuted} /><Text style={styles.refreshNoticeText}>Couldn’t refresh. Your last edition is here.</Text><Ionicons name="refresh-outline" size={16} color={primary} /></GlassPressable>}
                    {hasContent && <View style={styles.editionToolbar}><Text style={styles.editionLabel}>{discoverEditionLabel(exploreData?.edition?.publishedAt)}</Text><GlassPressable style={styles.surpriseButton} onPress={surprise} disabled={!allRecipes.length} accessibilityLabel="Surprise me with a recipe"><Ionicons name="shuffle-outline" size={16} color={primary} /><Text style={styles.surpriseText}>Surprise me</Text></GlassPressable></View>}
                    {activeCollection ? <View style={styles.collection}><SectionHeading title={activeCollection.title} subtitle={activeCollection.subtitle} /><RecipeGrid recipes={activeCollection.recipes} accent={activeCollection.accent} onView={openRecipe} /></View> : <>
                        {!!hero && <Animated.View entering={FadeInDown.duration(450).reduceMotion(ReduceMotion.System)} style={styles.heroSection}>
                            <FeatureRecipeCard recipe={hero} label={exploreData?.edition ? 'The daily pick' : 'On our radar'} onView={openRecipe} />
                        </Animated.View>}
                        {collections[0] && renderCollection(collections[0], 0)}
                        {renderCreators()}
                        {collections.slice(1).map((collection, index) => renderCollection(collection, index + 1))}
                    </>}
                    {!hasContent && <View style={styles.empty}><Ionicons name={loadError ? 'cloud-offline-outline' : 'restaurant-outline'} size={34} color={primary} /><Text style={styles.emptyTitle}>{loadError ? 'A little connection hiccup' : 'A fresh menu is on its way'}</Text><Text style={styles.emptyText}>{loadError ? 'Your inspiration will be here when you reconnect.' : 'Search for a favourite recipe or check back for a new edition.'}</Text><GlassPressable style={styles.retry} onPress={onRefresh}><Ionicons name="refresh-outline" size={16} color={primary} /><Text style={styles.retryText}>Refresh Discover</Text></GlassPressable></View>}
                </>}
            </ScrollView>}
        </SafeAreaView>
        <ViewRecipeModal isVisible={!!recipeToViewId} onClose={() => setRecipeToViewId(null)} onDismiss={finishDetailDismiss} recipeId={recipeToViewId} onEdit={handleEditRecipe} />
        <AddEditRecipeModal isVisible={isEditorVisible} onClose={() => setEditorVisible(false)} onDismiss={finishEditorDismiss} mealForRecipe={null} recipeToEdit={recipeToEdit} onRecipeSave={handleRecipeSaved} />
    </AmbientBackground>;
}

const styles = StyleSheet.create({
    page: { flex: 1, width: '100%', maxWidth: 760, alignSelf: 'center' },
    header: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 22, paddingTop: 10, paddingBottom: 15 },
    editionToolbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginHorizontal: 22, marginBottom: 13 },
    editionLabel: { fontSize: 10, fontWeight: '600', letterSpacing: 0.35, color: inkMuted },
    surpriseButton: { flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', minHeight: 36, paddingHorizontal: 12, borderRadius: 18, backgroundColor: '#E6EDDF', borderWidth: 1, borderColor: 'rgba(255,255,255,0.9)' },
    surpriseText: { color: primary, fontSize: 11, fontWeight: '600' },
    search: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 9, borderRadius: 24, minHeight: 48 },
    searchInput: { flex: 1, minWidth: 0, fontSize: 13, color: ink, minHeight: 48, paddingVertical: 11 },
    clearSearch: { width: 28, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 16 },
    topicsContainer: { height: 54 },
    topics: { paddingHorizontal: 22, gap: 8, alignItems: 'center', paddingBottom: 10 },
    topic: { minHeight: 35, borderRadius: 18, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.62)', borderWidth: 1, borderColor: '#FFF' },
    topicSelected: { backgroundColor: ink, borderColor: ink },
    topicDot: { width: 6, height: 6, borderRadius: 3 },
    topicText: { fontSize: 11, fontWeight: '500', color: ink },
    topicTextSelected: { color: '#FFF' },
    scrollContent: { paddingTop: 5, paddingBottom: 128 },
    inset: { paddingHorizontal: 22 },
    heroSection: { marginHorizontal: 22, marginBottom: 7 },
    collection: { paddingHorizontal: 22, marginTop: 15, marginBottom: 9 },
    sectionHeading: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, marginBottom: 17 },
    sectionTitle: { fontSize: 23, lineHeight: 28, fontWeight: '600', letterSpacing: -0.75, color: ink },
    sectionSubtitle: { fontSize: 12, lineHeight: 18, color: inkMuted, marginTop: 5 },
    seeAll: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 40, paddingLeft: 7 },
    seeAllText: { color: primary, fontSize: 11, fontWeight: '600' },
    creatorSection: { marginTop: 23, marginBottom: 10 },
    creatorRail: { paddingHorizontal: 22, gap: 13, paddingBottom: 8 },
    loading: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 70 },
    loadingText: { fontSize: 13, color: inkMuted, marginTop: 15 },
    empty: { paddingHorizontal: 30, paddingVertical: 55, alignItems: 'center' },
    emptyTitle: { fontSize: 23, fontWeight: '600', color: ink, textAlign: 'center', letterSpacing: -0.5, marginTop: 20 },
    emptyText: { fontSize: 14, lineHeight: 22, color: inkMuted, textAlign: 'center', marginTop: 10 },
    retry: { minHeight: 46, paddingHorizontal: 18, borderRadius: 23, flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 22, backgroundColor: '#E5ECDF' },
    retryText: { fontSize: 13, fontWeight: '600', color: primary },
    refreshNotice: { marginHorizontal: 22, marginBottom: 14, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#EEEBDD', borderRadius: 15 },
    refreshNoticeText: { flex: 1, color: inkMuted, fontSize: 11, lineHeight: 16 },
});
