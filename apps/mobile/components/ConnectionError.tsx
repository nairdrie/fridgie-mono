import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Ionicons name="cloud-offline-outline" size={64} color="#c2c2c2" />
        <Text style={styles.title}>Can&apos;t reach Fridgie</Text>
        <Text style={styles.body}>
          Your lists are safe. Check your connection and try again.
        </Text>
        <TouchableOpacity
          style={[styles.button, retrying && styles.buttonDisabled]}
          onPress={onRetry}
          disabled={retrying}
          accessibilityRole="button"
        >
          {retrying
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.buttonText}>Try again</Text>}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  title: { fontSize: 22, fontWeight: '700', color: '#333', marginTop: 20 },
  body: { fontSize: 15, color: '#777', textAlign: 'center', marginTop: 8, lineHeight: 21 },
  button: {
    marginTop: 28, backgroundColor: primary, borderRadius: 25,
    paddingVertical: 13, paddingHorizontal: 40, minWidth: 160, alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
