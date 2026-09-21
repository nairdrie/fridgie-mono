import AddEditRecipeModal from '@/components/AddEditRecipeModal';
import { BrandWordmark } from '@/components/ui/Brand';
import { AmbientBackground, GlassPressable, GlassSurface } from '@/components/ui/Glass';
import { useAuth } from '@/context/AuthContext';
import { useCookbook } from '@/context/CookbookContext';
import { useSharedRecipes } from '@/context/SharedRecipeContext';
import { recipeSourceLabel } from '@/utils/recipeImport';
import { ink, inkMuted, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/** A share belongs to the cookbook; it must never create a meal or shopping rows. */
export default function ImportRecipeScreen() {
  const { user, loading } = useAuth();
  const { addRecipe } = useCookbook();
  const { requests, ready, error, enqueue, dismiss, retry } = useSharedRecipes();
  const router = useRouter();
  const params = useLocalSearchParams<{ url?: string }>();
  const [visible, setVisible] = useState(false);
  const [opening, setOpening] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const importedParam = useRef<string | null>(null);
  const closing = useRef(false);
  const request = requests[0];
  const hasAccount = !!user && !user.isAnonymous && !!user.displayName;

  // Also supports fridgie://import-recipe?url=… without exposing native transport URLs.
  useEffect(() => {
    if (!ready || typeof params.url !== 'string' || importedParam.current === params.url) return;
    importedParam.current = params.url;
    setOpening(true);
    void enqueue(params.url).catch(() => setLinkError('Couldn’t keep this recipe link. Please paste it below.'))
      .finally(() => setOpening(false));
  }, [ready, params.url, enqueue]);

  useEffect(() => {
    if (ready && !loading && hasAccount && request && !closing.current) setVisible(true);
  }, [ready, loading, hasAccount, request]);

  const close = async () => {
    if (closing.current) return;
    closing.current = true;
    try {
      if (request) await dismiss(request.id);
      setVisible(false);
      router.replace('/profile');
    } catch {
      closing.current = false;
      Alert.alert('Couldn’t finish', 'Your recipe is still here. Please try again.');
    }
  };

  const waiting = loading || !ready || opening;
  const source = request ? recipeSourceLabel(request.input) : '';
  const message = linkError ?? error;

  return <AmbientBackground>
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <BrandWordmark height={28} />
        <GlassPressable onPress={() => { void close(); }} style={styles.close} accessibilityLabel="Cancel recipe import">
          <Ionicons name="close" color={ink} size={23} />
        </GlassPressable>
      </View>
      <View style={styles.content}>
        <GlassSurface style={styles.card}>
          <View style={styles.icon}><Ionicons name="book-outline" size={30} color={primary} /></View>
          <Text style={styles.title}>{request ? 'A new favourite' : 'Import a recipe'}</Text>
          <Text style={styles.body}>{!hasAccount
            ? 'Sign in to bring this recipe into your cookbook. Your shared link will be waiting here.'
            : 'We’ll read the recipe, then you can check the ingredients and steps before saving it.'}</Text>
          {!!request && <View style={styles.source}>
            <Text style={styles.sourceTitle}>{source || 'Shared recipe link'}</Text>
            <Text style={styles.link} numberOfLines={2} selectable>{request.input}</Text>
            {requests.length > 1 && <Text style={styles.link}>{requests.length - 1} more {requests.length === 2 ? 'link is' : 'links are'} waiting</Text>}
          </View>}
          {!!message && <Text style={styles.error} accessibilityRole="alert">{message}</Text>}
          {waiting && !message ? <ActivityIndicator color={primary} style={styles.spinner} accessibilityLabel="Opening your shared recipe" />
            : !ready ? <GlassPressable onPress={retry} style={styles.button}><Text style={styles.buttonText}>Try again</Text></GlassPressable>
            : !hasAccount ? <GlassPressable onPress={() => router.push('/login')} style={styles.button}><Text style={styles.buttonText}>Sign in to import</Text><Ionicons name="arrow-forward" size={18} color="#FFFFFF" /></GlassPressable>
            : <GlassPressable onPress={() => setVisible(true)} style={styles.button}><Text style={styles.buttonText}>{request ? 'Review recipe' : 'Paste a recipe link'}</Text><Ionicons name="arrow-forward" size={18} color="#FFFFFF" /></GlassPressable>}
          {!!message && ready && <GlassPressable onPress={retry} style={styles.retry}><Text style={styles.retryText}>Try receiving the share again</Text></GlassPressable>}
        </GlassSurface>
      </View>
      <AddEditRecipeModal
        isVisible={visible && hasAccount}
        mealForRecipe={null}
        initialImportUrl={request?.input}
        initialImportRequestId={request?.id}
        onClose={() => { void close(); }}
        onRecipeSave={async (_meal, _items, recipe) => { await addRecipe(recipe.id); }}
      />
    </SafeAreaView>
  </AmbientBackground>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { paddingHorizontal: 24, paddingTop: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  close: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.7)', justifyContent: 'center', alignItems: 'center' },
  content: { flex: 1, justifyContent: 'center', padding: 24 },
  card: { borderRadius: 30, padding: 26, alignItems: 'center' },
  icon: { width: 66, height: 66, borderRadius: 24, backgroundColor: '#DCEDE2', justifyContent: 'center', alignItems: 'center', marginBottom: 20 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.8, color: ink, textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 23, color: inkMuted, textAlign: 'center', marginTop: 12 },
  source: { width: '100%', padding: 15, borderRadius: 18, backgroundColor: 'rgba(35,120,94,0.06)', marginTop: 22, gap: 6 },
  sourceTitle: { fontSize: 14, color: ink, fontWeight: '600' },
  link: { fontSize: 12, lineHeight: 18, color: inkMuted },
  button: { marginTop: 24, borderRadius: 21, minHeight: 52, width: '100%', backgroundColor: primary, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10, paddingHorizontal: 14 },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  spinner: { marginTop: 26 },
  error: { marginTop: 18, fontSize: 14, lineHeight: 21, textAlign: 'center', color: '#A44133' },
  retry: { padding: 12, marginTop: 8 },
  retryText: { fontSize: 13, color: primary, fontWeight: '600', textAlign: 'center' },
});
