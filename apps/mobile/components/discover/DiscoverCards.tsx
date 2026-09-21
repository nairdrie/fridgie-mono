import { GlassPressable, GlassSurface } from '@/components/ui/Glass';
import type { ExploreCreator, Recipe } from '@/types/types';
import { recipeQuickDetails } from '@/utils/discover';
import { getCardStyleFromTags } from '@/utils/recipeStyling';
import { ink, inkMuted, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

export const discoveryAccents = {
  sage: { background: '#DFEADB', wash: '#F0F4EA', detail: '#A9C4A7', ink: '#355642' },
  peach: { background: '#F4DCCE', wash: '#FBEEE5', detail: '#DCA58C', ink: '#80543E' },
  lemon: { background: '#EEE5BC', wash: '#F8F4E2', detail: '#D8C475', ink: '#706133' },
} as const;
export type DiscoveryAccent = keyof typeof discoveryAccents;

export function CuratedBadge({ compact = false }: { compact?: boolean }) {
  return <View style={[styles.curatedBadge, compact && styles.compactBadge]}>
    <Ionicons name="sparkles-outline" size={compact ? 10 : 12} color={primary} />
    <Text style={[styles.curatedText, compact && styles.compactBadgeText]}>Fridgie-curated</Text>
  </View>;
}

export function CreatorAvatar({ name, photoURL, accent = 'sage', size = 64 }: {
  name: string; photoURL?: string | null; accent?: DiscoveryAccent; size?: number;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [photoURL]);
  const colors = discoveryAccents[accent];
  const initials = name.trim().split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join('').toUpperCase() || 'F';
  return <View style={[styles.avatar, { width: size, height: size, borderRadius: size * 0.37, backgroundColor: colors.background }]}>
    {photoURL && !failed
      ? <Image source={{ uri: photoURL }} style={StyleSheet.absoluteFill} onError={() => setFailed(true)} />
      : <><View style={[styles.avatarOrb, { backgroundColor: colors.detail, width: size * 0.9, height: size * 0.9, borderRadius: size, left: size * 0.45, top: -size * 0.38 }]} /><Text style={{ fontSize: size * 0.34, fontWeight: '600', letterSpacing: -size * 0.025, color: colors.ink }}>{initials}</Text></>}
  </View>;
}

function RecipeArtwork({ recipe, accent, style }: { recipe: Recipe; accent: DiscoveryAccent; style?: StyleProp<ViewStyle> }) {
  const colors = discoveryAccents[accent];
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [recipe.photoURL]);
  return <View style={[styles.artwork, { backgroundColor: colors.background }, style]}>
    {recipe.photoURL && !failed ? <Image source={{ uri: recipe.photoURL }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setFailed(true)} /> : <>
      <View style={[styles.artworkOrb, { backgroundColor: colors.detail }]} />
      <View style={styles.plate}><View style={[styles.plateCenter, { backgroundColor: colors.wash }]}><Ionicons name={getCardStyleFromTags(recipe.tags).icon} size={56} color={colors.ink} /></View></View>
      <View style={[styles.artworkDash, { backgroundColor: colors.detail }]} />
    </>}
  </View>;
}

export function FeatureRecipeCard({ recipe, label, onView }: { recipe: Recipe; label: string; onView: (id: string) => void }) {
  return <GlassPressable style={styles.hero} onPress={() => onView(recipe.id)} accessibilityLabel={`View featured recipe, ${recipe.name}`}>
    <RecipeArtwork recipe={recipe} accent="sage" style={StyleSheet.absoluteFill} />
    <View style={styles.heroShade} />
    <GlassSurface style={styles.heroBadge} intensity={70}><View style={styles.freshDot} /><Text style={styles.heroBadgeText}>{label}</Text></GlassSurface>
    <GlassSurface style={styles.heroCaption} intensity={85}>
      <Text style={styles.heroEyebrow}>{recipe.contentOrigin === 'ai-curated' ? 'FRIDGIE ORIGINAL · AI RECIPE' : recipe.contentOrigin === 'ai-adapted' ? 'AI-ADAPTED RECIPE' : recipe.category || 'ON THE MENU'}</Text>
      <Text style={styles.heroTitle} numberOfLines={3}>{recipe.name}</Text>
      <View style={styles.heroBottom}><View style={{ flex: 1 }}><Text style={styles.heroMeta}>{recipeQuickDetails(recipe)}</Text>{!!recipe.authorName && <Text style={styles.heroAuthor} numberOfLines={1}>{recipe.authorName}</Text>}</View><View style={styles.heroArrow}><Ionicons name="arrow-up-outline" size={23} color="#FFF" style={{ transform: [{ rotate: '45deg' }] }} /></View></View>
    </GlassSurface>
  </GlassPressable>;
}

export function RecipeTile({ recipe, accent = 'sage', tall = false, onView }: { recipe: Recipe; accent?: DiscoveryAccent; tall?: boolean; onView: (id: string) => void }) {
  return <GlassPressable style={styles.tile} onPress={() => onView(recipe.id)} accessibilityLabel={`View ${recipe.name}${recipe.contentOrigin === 'ai-curated' ? ', AI-created recipe' : recipe.contentOrigin === 'ai-adapted' ? ', adapted from an AI recipe' : ''}`}>
    <RecipeArtwork recipe={recipe} accent={accent} style={{ height: tall ? 194 : 158 }} />
    <View style={styles.tileCopy}>
      <Text style={styles.tileCategory} numberOfLines={1}>{recipe.category || 'For your cookbook'}</Text>
      <Text style={styles.tileTitle} numberOfLines={3}>{recipe.name}</Text>
      <Text style={styles.tileMeta} numberOfLines={1}>{recipeQuickDetails(recipe)}</Text>
      {(recipe.contentOrigin === 'ai-curated' || recipe.contentOrigin === 'ai-adapted') && <View style={styles.aiLine}><Ionicons name="sparkles-outline" size={10} color={primary} /><Text style={styles.aiText}>{recipe.contentOrigin === 'ai-adapted' ? 'AI-adapted' : 'AI recipe'}</Text></View>}
    </View>
  </GlassPressable>;
}

export function RecipeGrid({ recipes, accent = 'sage', onView }: { recipes: Recipe[]; accent?: DiscoveryAccent; onView: (id: string) => void }) {
  return <View style={styles.grid}>
    {[0, 1].map(column => <View key={column} style={[styles.column, column === 1 && { paddingTop: 19 }]}>
      {recipes.filter((_, index) => index % 2 === column).map((recipe, index) => <RecipeTile key={recipe.id} recipe={recipe} accent={accent} tall={(column + index) % 2 === 0} onView={onView} />)}
    </View>)}
  </View>;
}

export function DiscoverCreatorCard({ creator, onPress, fullWidth = false }: { creator: ExploreCreator; onPress: () => void; fullWidth?: boolean }) {
  const colors = discoveryAccents[creator.accent ?? 'sage'];
  const curated = creator.profileKind === 'curated';
  return <GlassPressable style={[styles.creator, { backgroundColor: colors.wash }, fullWidth && styles.creatorFull]} onPress={onPress} accessibilityLabel={`View ${creator.displayName}'s cookbook${curated ? ', fictional Fridgie-curated creator' : ''}`}>
    <View style={styles.creatorTop}><CreatorAvatar name={creator.displayName || 'Fridgie cook'} photoURL={creator.photoURL} accent={creator.accent} /><View style={styles.creatorArrow}><Ionicons name="arrow-up-outline" size={18} color={colors.ink} style={{ transform: [{ rotate: '45deg' }] }} /></View></View>
    <Text style={styles.creatorName} numberOfLines={1}>{creator.displayName || 'Fridgie cook'}</Text>
    {curated ? <CuratedBadge compact /> : <Text style={styles.communityLabel}>Community kitchen</Text>}
    {!!creator.specialty && <Text style={styles.creatorSpecialty} numberOfLines={2}>{creator.specialty}</Text>}
    {!creator.specialty && !!creator.featuredRecipe && <Text style={styles.creatorSpecialty} numberOfLines={2}>{creator.featuredRecipe.name}</Text>}
    <View style={styles.creatorFooter}><Ionicons name="book-outline" size={13} color={inkMuted} /><Text style={styles.creatorCount}>{creator.recipeCount} {creator.recipeCount === 1 ? 'recipe' : 'recipes'}</Text><Text style={styles.creatorCta}>Open cookbook</Text></View>
  </GlassPressable>;
}

const styles = StyleSheet.create({
  curatedBadge: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(35,120,94,0.08)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 99 },
  curatedText: { color: primary, fontSize: 11, fontWeight: '600' },
  compactBadge: { paddingHorizontal: 8, paddingVertical: 5, gap: 4 },
  compactBadgeText: { fontSize: 9 },
  avatar: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: 2, borderColor: 'rgba(255,255,255,0.8)' },
  avatarOrb: { position: 'absolute', opacity: 0.65 },
  artwork: { justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  artworkOrb: { position: 'absolute', width: 190, height: 190, borderRadius: 95, top: -115, right: -25, opacity: 0.48 },
  artworkDash: { position: 'absolute', width: 78, height: 11, borderRadius: 8, bottom: 18, left: -30, transform: [{ rotate: '-45deg' }], opacity: 0.4 },
  plate: { width: 128, height: 128, borderRadius: 64, backgroundColor: '#FDFCF6', padding: 13, shadowColor: ink, shadowOpacity: 0.1, shadowOffset: { width: 0, height: 10 }, shadowRadius: 16 },
  plateCenter: { flex: 1, borderRadius: 60, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(23,63,53,0.05)' },
  hero: { minHeight: 382, borderRadius: 32, overflow: 'hidden', backgroundColor: '#DCE7D9', borderWidth: 1, borderColor: '#FFF' },
  heroShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(20,50,33,0.04)' },
  heroBadge: { alignSelf: 'flex-start', margin: 17, borderRadius: 99, paddingVertical: 8, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', gap: 6 },
  freshDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: primary },
  heroBadgeText: { fontSize: 10, fontWeight: '600', letterSpacing: 0.2, color: ink },
  heroCaption: { marginHorizontal: 14, marginTop: 130, marginBottom: 14, padding: 19, borderRadius: 24 },
  heroEyebrow: { fontSize: 8, fontWeight: '700', letterSpacing: 1.45, color: primary, textTransform: 'uppercase', marginBottom: 8 },
  heroTitle: { fontSize: 29, lineHeight: 33, fontWeight: '700', letterSpacing: -1.1, color: ink },
  heroBottom: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 13 },
  heroMeta: { fontSize: 12, fontWeight: '500', color: inkMuted },
  heroAuthor: { fontSize: 11, color: inkMuted, marginTop: 3 },
  heroArrow: { width: 44, height: 44, borderRadius: 22, backgroundColor: primary, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', alignItems: 'flex-start', gap: 13 },
  column: { flex: 1, minWidth: 0, gap: 14 },
  tile: { borderRadius: 25, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.84)', borderWidth: 1, borderColor: '#FFF', shadowColor: ink, shadowOpacity: 0.025, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } },
  tileCopy: { padding: 13, paddingBottom: 15 },
  tileCategory: { fontSize: 8, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', color: primary, marginBottom: 6 },
  tileTitle: { fontSize: 16, lineHeight: 21, fontWeight: '600', letterSpacing: -0.45, color: ink },
  tileMeta: { fontSize: 10, lineHeight: 16, color: inkMuted, marginTop: 7 },
  aiLine: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  aiText: { fontSize: 9, fontWeight: '500', color: primary },
  creator: { width: 258, borderRadius: 27, borderWidth: 1, borderColor: '#FFF', padding: 19 },
  creatorFull: { width: '100%' },
  creatorTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 },
  creatorArrow: { backgroundColor: 'rgba(255,255,255,0.55)', borderRadius: 17, width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  creatorName: { fontSize: 20, fontWeight: '600', letterSpacing: -0.6, color: ink, marginBottom: 7 },
  communityLabel: { color: inkMuted, fontSize: 10 },
  creatorSpecialty: { fontSize: 12, lineHeight: 18, color: inkMuted, marginTop: 12, minHeight: 36 },
  creatorFooter: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 18, paddingTop: 13, borderTopWidth: 1, borderTopColor: 'rgba(23,63,53,0.09)' },
  creatorCount: { fontSize: 10, color: inkMuted },
  creatorCta: { flex: 1, textAlign: 'right', fontSize: 10, fontWeight: '600', color: primary },
});
