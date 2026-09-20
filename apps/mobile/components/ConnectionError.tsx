import { AmbientBackground, GlassPressable, GlassSurface } from '@/components/ui/Glass';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { primary } from '@/utils/styles';

/**
 * The whole-screen "we cannot reach the server" state.
 *
 * This replaces the entire tab UI rather than sitting inside the header. A
 * failure shown only in the header left a perfectly plausible EMPTY LIST
 * rendered underneath it — which reads as "you have nothing planned this week"
 * rather than "we could not load your week". Being wrong quietly is worse than
 * being unavailable loudly, especially for a screen whose whole job is telling
 * you what you already put there.
 *
 * The header and the body also live in different parts of the tree — the header
 * is the navigator's, the body is the screen's — so nothing forced them to
 * agree. Owning the state one level above both is what makes that impossible.
 */
export default function ConnectionError({
  onRetry,
  retrying = false,
}: {
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <AmbientBackground>
    <SafeAreaView style={styles.safe}>
      <Animated.View entering={FadeInDown.duration(500).reduceMotion(ReduceMotion.System)} style={styles.container}>
        <View style={styles.iconHalo}><GlassSurface style={styles.iconCard}><Ionicons name="cloud-offline-outline" size={42} color={primary} /></GlassSurface></View>
        <Text style={styles.eyebrow}>A MOMENT TO RECONNECT</Text>
        <Text style={styles.title}>Can&apos;t reach Fridgie</Text>
        <Text style={styles.body}>
          Your lists are safe. Check your connection and try again.
        </Text>
        <GlassPressable
          style={[styles.button, retrying && styles.buttonDisabled]}
          onPress={onRetry}
          disabled={retrying}
          accessibilityRole="button"
        >
          {retrying
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.buttonText}>Try again</Text>}
        </GlassPressable>
      </Animated.View>
    </SafeAreaView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: 'transparent' },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 34 },
  iconHalo: { width: 152, height: 152, borderRadius: 76, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(220,237,226,0.65)', marginBottom: 35 },
  iconCard: { width: 100, height: 100, borderRadius: 33, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-8deg' }] },
  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.5, color: '#78857D', marginBottom: 11 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.9, color: '#173F35', textAlign: 'center' },
  body: { fontSize: 15, color: '#78857D', textAlign: 'center', marginTop: 12, lineHeight: 23, maxWidth: 280 },
  button: { marginTop: 30, backgroundColor: primary, borderRadius: 20, paddingVertical: 17, paddingHorizontal: 42, minWidth: 180, alignItems: 'center', shadowColor: '#173F35', shadowOffset: { width: 0, height: 7 }, shadowRadius: 14, shadowOpacity: 0.12 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
