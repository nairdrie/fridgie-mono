import { AmbientBackground, GlassPressable as TouchableOpacity, GlassSurface } from '@/components/ui/Glass';
import { useAuth } from '@/context/AuthContext';
import {
  CLAUDE_CONNECTOR_URL,
  ClaudeConnection,
  ClaudeLinkCode,
  createClaudeLinkCode,
  disconnectClaude,
  getClaudeConnections,
} from '@/utils/api';
import { ink, inkFaint, inkMuted, mint, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  SafeAreaView,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

/**
 * Connect Claude — how someone gets "plan me three dinners" in a Claude chat
 * to land in this app.
 *
 * Claude talks to the connector at CLAUDE_CONNECTOR_URL. When it's added,
 * Claude opens the connector's sign-in page, which asks for the one-time code
 * made here. That code is the whole of the sign-in: the phone is already
 * signed in, so it vouches for the browser, and nobody has to type a password
 * into a web page.
 */

const secondsLeft = (expiresAt: string) => Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));

const formatCountdown = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

function relativeDate(iso: string | null): string {
  if (!iso) return 'not used yet';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

const Step = ({ n, children }: { n: number; children: React.ReactNode }) => (
  <View style={styles.step}>
    <View style={styles.stepNumber}><Text style={styles.stepNumberText}>{n}</Text></View>
    <Text style={styles.stepText}>{children}</Text>
  </View>
);

export default function ConnectClaudeScreen() {
  const router = useRouter();
  const { selectedGroup } = useAuth();

  const [linkCode, setLinkCode] = useState<ClaudeLinkCode | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [creating, setCreating] = useState(false);
  const [connections, setConnections] = useState<ClaudeConnection[] | null>(null);

  const loadConnections = useCallback(() => {
    getClaudeConnections()
      .then(setConnections)
      .catch((error) => {
        console.error('Could not load Claude connections:', error);
        setConnections([]);
      });
  }, []);

  // Coming back from Claude after finishing the sign-in is the moment the new
  // connection should appear, so this refreshes on focus rather than on mount.
  useFocusEffect(loadConnections);

  useEffect(() => {
    if (!linkCode) return;
    const tick = () => {
      const left = secondsLeft(linkCode.expiresAt);
      setRemaining(left);
      if (left === 0) setLinkCode(null);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [linkCode]);

  const getCode = async () => {
    setCreating(true);
    try {
      setLinkCode(await createClaudeLinkCode(selectedGroup?.id));
    } catch (error) {
      console.error('Could not create a Claude link code:', error);
      Alert.alert('Couldn\'t get a code', 'Check your connection and try again.');
    } finally {
      setCreating(false);
    }
  };

  const shareUrl = () => {
    Share.share(Platform.OS === 'ios' ? { url: CLAUDE_CONNECTOR_URL } : { message: CLAUDE_CONNECTOR_URL }).catch(() => {});
  };

  const confirmDisconnect = (connection: ClaudeConnection) => {
    Alert.alert(
      `Disconnect ${connection.clientName}?`,
      'It will stop being able to add meals and groceries right away. You can connect again any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            setConnections((current) => current?.filter((c) => c.id !== connection.id) ?? null);
            try {
              await disconnectClaude(connection.id);
            } catch (error) {
              console.error('Could not disconnect:', error);
              Alert.alert('Couldn\'t disconnect', 'Check your connection and try again.');
              loadConnections();
            }
          },
        },
      ],
    );
  };

  return (
    <AmbientBackground>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.container}>
          <GlassSurface style={styles.backGlass}>
            <TouchableOpacity style={styles.backButton} onPress={() => router.back()} accessibilityLabel="Go back">
              <Ionicons name="chevron-back" size={21} color={ink} />
            </TouchableOpacity>
          </GlassSurface>

          <Text style={styles.eyebrow}>CONNECTIONS</Text>
          <Text style={styles.title}>Connect Claude</Text>
          <Text style={styles.subtitle}>
            Ask Claude to plan your meals or build a grocery list, and it adds them straight to Fridgie
            {selectedGroup?.name ? ` — to ${selectedGroup.name} unless you say otherwise` : ''}.
          </Text>

          <View style={styles.card}>
            <Step n={1}>In Claude, open <Text style={styles.bold}>Settings → Connectors</Text> and choose <Text style={styles.bold}>Add custom connector</Text>.</Step>
            <Step n={2}>Name it Fridgie and paste this URL:</Step>
            <TouchableOpacity style={styles.urlBox} onPress={shareUrl} accessibilityLabel="Share connector URL">
              <Text style={styles.urlText} selectable numberOfLines={1}>{CLAUDE_CONNECTOR_URL}</Text>
              <Ionicons name="share-outline" size={18} color={primary} />
            </TouchableOpacity>
            <Step n={3}>Tap <Text style={styles.bold}>Connect</Text>. When Fridgie asks for a code, enter this one:</Step>

            {linkCode ? (
              <View style={styles.codeBox} accessible accessibilityLabel={`Code ${linkCode.code.split('').join(' ')}`}>
                <Text style={styles.codeText} selectable>{linkCode.code}</Text>
                <Text style={styles.codeHint}>Expires in {formatCountdown(remaining)} · works once</Text>
              </View>
            ) : (
              <TouchableOpacity style={styles.primaryButton} onPress={getCode} disabled={creating}>
                {creating
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.primaryButtonText}>Get a code</Text>}
              </TouchableOpacity>
            )}
          </View>

          <Text style={styles.sectionTitle}>Then just ask</Text>
          <View style={styles.card}>
            {[
              'Plan three easy weeknight dinners for next week and add them to Fridgie.',
              'Make me a grocery list for tacos for 6.',
              'Add milk, eggs and coffee to my list.',
            ].map((example) => (
              <View key={example} style={styles.example}>
                <Ionicons name="chatbubble-ellipses-outline" size={16} color={inkMuted} />
                <Text style={styles.exampleText}>“{example}”</Text>
              </View>
            ))}
          </View>

          <Text style={styles.sectionTitle}>Connected</Text>
          {connections === null ? (
            <ActivityIndicator color={primary} style={{ marginTop: 12 }} />
          ) : connections.length === 0 ? (
            <Text style={styles.empty}>Nothing connected yet.</Text>
          ) : (
            connections.map((connection) => (
              <View key={connection.id} style={styles.connectionRow}>
                <Ionicons name="sparkles-outline" size={18} color={primary} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.connectionName}>{connection.clientName}</Text>
                  <Text style={styles.connectionMeta}>Last used {relativeDate(connection.lastUsedAt)}</Text>
                </View>
                <TouchableOpacity onPress={() => confirmDisconnect(connection)} accessibilityLabel={`Disconnect ${connection.clientName}`}>
                  <Text style={styles.disconnect}>Disconnect</Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: 'transparent', paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
  container: { paddingHorizontal: 24, paddingTop: 17, paddingBottom: 48 },
  backGlass: { borderRadius: 19, alignSelf: 'flex-start', marginBottom: 23 },
  backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { fontSize: 10, letterSpacing: 1.5, fontWeight: '700', color: '#78857D', marginBottom: 10 },
  title: { fontSize: 32, lineHeight: 37, fontWeight: '700', letterSpacing: -1.1, marginBottom: 13, color: ink },
  subtitle: { fontSize: 14, lineHeight: 22, color: '#78857D', marginBottom: 24 },
  card: { borderRadius: 23, padding: 20, backgroundColor: 'rgba(255,255,255,0.8)', gap: 14, marginBottom: 24 },
  step: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  stepNumber: { width: 24, height: 24, borderRadius: 12, backgroundColor: mint, alignItems: 'center', justifyContent: 'center' },
  stepNumberText: { fontSize: 12, fontWeight: '700', color: primary },
  stepText: { flex: 1, fontSize: 15, lineHeight: 22, color: ink },
  bold: { fontWeight: '700' },
  urlBox: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14, backgroundColor: '#F1F5EF', marginLeft: 36 },
  urlText: { flex: 1, fontSize: 14, fontWeight: '600', color: ink, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  codeBox: { alignItems: 'center', borderRadius: 18, paddingVertical: 18, backgroundColor: mint },
  codeText: { fontSize: 32, fontWeight: '700', letterSpacing: 4, color: ink, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  codeHint: { fontSize: 12, color: inkMuted, marginTop: 6 },
  primaryButton: { borderRadius: 18, paddingVertical: 16, alignItems: 'center', backgroundColor: primary },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: inkMuted, marginBottom: 10, marginLeft: 4 },
  example: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  exampleText: { flex: 1, fontSize: 14, lineHeight: 21, color: ink },
  empty: { fontSize: 14, color: inkFaint, marginLeft: 4 },
  connectionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 20, padding: 18, marginBottom: 10, backgroundColor: 'rgba(255,255,255,0.8)' },
  connectionName: { fontSize: 15, fontWeight: '600', color: ink },
  connectionMeta: { fontSize: 12, color: inkFaint, marginTop: 2 },
  disconnect: { fontSize: 14, fontWeight: '600', color: '#B3261E' },
});
