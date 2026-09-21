import { AmbientBackground, GlassPressable, GlassSurface, useGlassPreferences } from '@/components/ui/Glass';
import { useAuth } from '@/context/AuthContext';
import { ConnectionKind, UserConnection, UserProfile } from '@/types/types';
import { followUser, getUserConnections, getUserProfile, removeFollower, unfollowUser } from '@/utils/api';
import { ink, inkMuted, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Modal, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ConnectionsScreen() {
  const params = useLocalSearchParams<{ uid?: string; kind?: string }>();
  const { user } = useAuth();
  const router = useRouter();
  const { reduceMotion } = useGlassPreferences();
  const ownerId = typeof params.uid === 'string' ? params.uid : user?.uid ?? '';
  const kind: ConnectionKind = params.kind === 'following' ? 'following' : 'followers';
  const isOwnProfile = ownerId === user?.uid;
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [people, setPeople] = useState<UserConnection[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [removing, setRemoving] = useState<UserConnection | null>(null);
  const removalName = useRef('This person');
  const pending = useRef(new Set<string>());
  const version = useRef(0);
  const focused = useRef(false);
  const fetchingMore = useRef(false);
  const currentKey = useRef('');
  currentKey.current = `${ownerId}:${kind}`;

  const load = useCallback(async (refresh = false) => {
    const request = ++version.current;
    fetchingMore.current = false;
    setLoadingMore(false);
    setMoreError(false);
    setError(null);
    setActionError(null);
    setRemoving(null);
    if (refresh) setRefreshing(true);
    else { setLoading(true); setPeople([]); setCursor(null); setProfile(null); }
    try {
      if (!ownerId) throw new Error('Missing profile');
      const [page, owner] = await Promise.all([
        getUserConnections(ownerId, kind),
        // The list remains usable even if its optional count/name read fails.
        getUserProfile(ownerId).catch(() => null),
      ]);
      if (!focused.current || request !== version.current) return;
      setPeople(page.users);
      setCursor(page.nextCursor);
      setProfile(owner);
    } catch {
      if (focused.current && request === version.current) setError(`Couldn’t load ${kind}. Please try again.`);
    } finally {
      if (focused.current && request === version.current) { setLoading(false); setRefreshing(false); }
    }
  }, [ownerId, kind]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    void load();
    return () => { focused.current = false; version.current += 1; };
  }, [load]));

  const reloadCurrent = useRef(() => {});
  reloadCurrent.current = () => { void load(true); };

  const loadMore = async () => {
    if (!cursor || fetchingMore.current || loading || refreshing || pending.current.size > 0) return;
    fetchingMore.current = true;
    setLoadingMore(true);
    setMoreError(false);
    const request = version.current;
    try {
      const page = await getUserConnections(ownerId, kind, cursor);
      if (!focused.current || request !== version.current) return;
      setPeople(previous => {
        const ids = new Set(previous.map(person => person.uid));
        return [...previous, ...page.users.filter(person => !ids.has(person.uid))];
      });
      setCursor(page.nextCursor);
    } catch {
      if (focused.current && request === version.current) setMoreError(true);
    } finally {
      if (request === version.current) { fetchingMore.current = false; setLoadingMore(false); }
    }
  };

  const updateConnection = async (person: UserConnection, remove = false) => {
    if (!user || person.uid === user.uid || pending.current.has(person.uid)) return;
    if (remove && (!isOwnProfile || kind !== 'followers')) return;
    pending.current.add(person.uid);
    setPendingIds(new Set(pending.current));
    setActionError(null);
    setRemoving(null);
    const key = currentKey.current;
    const requestAtStart = version.current;
    const following = !person.isFollowing;
    try {
      if (remove) await removeFollower(person.uid);
      else if (following) await followUser(person.uid);
      else await unfollowUser(person.uid);
      if (!focused.current) return;
      if (key !== currentKey.current || requestAtStart !== version.current) { reloadCurrent.current(); return; }
      // Only reflect confirmed changes. Failures leave both the row and counts
      // intact, and the ref above blocks double taps before React renders.
      setPeople(previous => remove || (isOwnProfile && kind === 'following' && !following)
        ? previous.filter(item => item.uid !== person.uid)
        : previous.map(item => item.uid === person.uid ? { ...item, isFollowing: following } : item));
      if (isOwnProfile) setProfile(previous => previous ? {
        ...previous,
        ...(remove
          ? { followerCount: Math.max(0, (previous.followerCount ?? 0) - 1) }
          : { followingCount: Math.max(0, (previous.followingCount ?? 0) + (following ? 1 : -1)) }),
      } : previous);
    } catch {
      if (focused.current) setActionError(remove ? 'Couldn’t remove this follower. Please try again.' : 'Couldn’t update this connection. Please try again.');
    } finally {
      pending.current.delete(person.uid);
      setPendingIds(new Set(pending.current));
    }
  };

  const renderPerson = ({ item }: { item: UserConnection }) => {
    const name = item.displayName || 'Fridgie cook';
    const isYou = item.uid === user?.uid;
    const busy = pendingIds.has(item.uid);
    return <View style={styles.personRow}>
      <GlassPressable style={styles.personIdentity} onPress={() => router.push({ pathname: '/profile/[uid]', params: { uid: item.uid } })} accessibilityLabel={`View ${name}’s profile`}>
        {item.photoURL ? <Image source={{ uri: item.photoURL }} style={styles.avatar} /> : <View style={[styles.avatar, styles.avatarPlaceholder]}><Text style={styles.initial}>{name.charAt(0).toUpperCase()}</Text></View>}
        <View style={styles.personCopy}><Text numberOfLines={2} style={styles.personName}>{name}</Text>{isYou ? <Text style={styles.personDetail}>You</Text> : isOwnProfile && kind === 'followers' ? <Text style={styles.personDetail}>Follows you</Text> : null}</View>
      </GlassPressable>
      {!isYou && <GlassPressable style={[styles.followButton, item.isFollowing && styles.followingButton]} disabled={busy || refreshing} onPress={() => { void updateConnection(item); }} accessibilityLabel={`${item.isFollowing ? 'Unfollow' : 'Follow'} ${name}`} accessibilityState={{ busy, disabled: busy || refreshing }}>
        {busy ? <ActivityIndicator size="small" color={item.isFollowing ? primary : '#fff'} /> : <Text style={[styles.followText, item.isFollowing && styles.followingText]}>{item.isFollowing ? 'Following' : isOwnProfile && kind === 'followers' ? 'Follow back' : 'Follow'}</Text>}
      </GlassPressable>}
      {isOwnProfile && kind === 'followers' && !isYou && <GlassPressable style={styles.moreButton} disabled={busy || refreshing} onPress={() => { removalName.current = name; setRemoving(item); }} accessibilityLabel={`Remove ${name} from your followers`}><Ionicons name="ellipsis-horizontal" size={20} color={inkMuted} /></GlassPressable>}
    </View>;
  };

  return <AmbientBackground>
    <StatusBar style="dark" />
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <GlassPressable style={styles.backButton} onPress={() => router.canGoBack() ? router.back() : router.replace('/profile')} accessibilityLabel="Go back"><Ionicons name="chevron-back" size={23} color={ink} /></GlassPressable>
        <View style={styles.heading}><Text style={styles.title}>Connections</Text>{!isOwnProfile && profile?.displayName && <Text style={styles.ownerName} numberOfLines={1}>{profile.displayName}</Text>}</View>
        <View style={styles.backButtonSpacer} />
      </View>
      <GlassSurface style={styles.tabs} intensity={35}>
        {(['followers', 'following'] as const).map(tab => <GlassPressable key={tab} style={[styles.tab, kind === tab && styles.selectedTab]} onPress={() => router.setParams({ kind: tab })} accessibilityRole="tab" accessibilityState={{ selected: kind === tab }} accessibilityLabel={tab === 'followers' ? 'Followers' : 'Following'}>
          <Text style={[styles.tabText, kind === tab && styles.selectedTabText]}>{tab === 'followers' ? 'Followers' : 'Following'}</Text>
          {profile && <Text style={styles.tabCount}>{(tab === 'followers' ? profile.followerCount : profile.followingCount) ?? 0}</Text>}
        </GlassPressable>)}
      </GlassSurface>
      {actionError && <View style={styles.errorBanner} accessibilityLiveRegion="polite"><Text style={styles.errorText}>{actionError}</Text><GlassPressable style={styles.moreButton} onPress={() => setActionError(null)} accessibilityLabel="Dismiss error"><Ionicons name="close" size={20} color={inkMuted} /></GlassPressable></View>}
      {loading ? <View style={styles.centered}><ActivityIndicator color={primary} accessibilityLabel={`Loading ${kind}`} /></View> : <FlatList
        data={people}
        renderItem={renderPerson}
        extraData={pendingIds}
        keyExtractor={person => person.uid}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { if (pending.current.size === 0) void load(true); }} tintColor={primary} />}
        ListHeaderComponent={error ? <View style={styles.errorBanner}><Text style={styles.errorText}>{error}</Text><GlassPressable onPress={() => { void load(true); }} style={styles.retryButton}><Text style={styles.retryText}>Retry</Text></GlassPressable></View> : null}
        ListEmptyComponent={!error && !cursor ? <View style={styles.empty}><View style={styles.emptyIcon}><Ionicons name="people-outline" size={32} color={primary} /></View><Text style={styles.emptyTitle}>{kind === 'followers' ? 'No followers yet' : 'Not following anyone yet'}</Text><Text style={styles.emptyDetail}>{kind === 'followers' ? (isOwnProfile ? 'People who follow you will appear here.' : 'This profile has no followers yet.') : (isOwnProfile ? 'Follow a cook from Discover to find them here.' : 'This profile isn’t following anyone yet.')}</Text>{isOwnProfile && kind === 'following' && <GlassPressable style={styles.discoverButton} onPress={() => router.navigate('/explore')}><Text style={styles.followText}>Find people</Text></GlassPressable>}</View> : null}
        ListFooterComponent={cursor ? <View style={styles.footer}>{loadingMore ? <ActivityIndicator color={primary} /> : <GlassPressable style={styles.loadMore} onPress={() => { void loadMore(); }} disabled={pendingIds.size > 0}><Text style={styles.retryText}>{moreError ? 'Couldn’t load more. Tap to retry' : 'Load more'}</Text></GlassPressable>}</View> : null}
      />}
    </SafeAreaView>
    <Modal visible={!!removing} transparent animationType={reduceMotion ? 'none' : 'fade'} onRequestClose={() => setRemoving(null)}>
      <View style={styles.confirmBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setRemoving(null)} accessibilityLabel="Cancel removal" />
        <GlassSurface style={styles.confirmCard} intensity={80} accessibilityViewIsModal>
          <Text style={styles.confirmTitle}>Remove follower?</Text>
          <Text style={styles.confirmDetail}>{removalName.current} will no longer follow you. They can follow you again.</Text>
          <View style={styles.confirmActions}><GlassPressable style={styles.cancelButton} onPress={() => setRemoving(null)}><Text style={styles.retryText}>Cancel</Text></GlassPressable><GlassPressable style={styles.removeButton} onPress={() => { if (removing) void updateConnection(removing, true); }}><Text style={styles.followText}>Remove</Text></GlassPressable></View>
        </GlassSurface>
      </View>
    </Modal>
  </AmbientBackground>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 18, gap: 10 },
  backButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.7)' },
  backButtonSpacer: { width: 44 },
  heading: { flex: 1, alignItems: 'center' },
  title: { fontSize: 21, fontWeight: '700', letterSpacing: -0.6, color: ink },
  ownerName: { fontSize: 12, color: inkMuted, marginTop: 3 },
  tabs: { flexDirection: 'row', marginHorizontal: 20, padding: 4, borderRadius: 26, backgroundColor: 'rgba(230,236,227,0.7)', marginBottom: 16 },
  tab: { flex: 1, minHeight: 44, borderRadius: 23, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  selectedTab: { backgroundColor: 'rgba(255,255,255,0.94)', boxShadow: '0 2px 6px rgba(23,63,53,0.08)' },
  tabText: { fontSize: 14, color: inkMuted, fontWeight: '500' },
  selectedTabText: { color: ink, fontWeight: '700' },
  tabCount: { color: inkMuted, fontSize: 12, fontWeight: '600' },
  list: { paddingHorizontal: 20, paddingBottom: 24, flexGrow: 1 },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(23,63,53,0.1)' },
  personIdentity: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 48 },
  avatar: { width: 46, height: 46, borderRadius: 23 },
  avatarPlaceholder: { backgroundColor: '#DCEDE2', alignItems: 'center', justifyContent: 'center' },
  initial: { color: primary, fontSize: 19, fontWeight: '600' },
  personCopy: { flex: 1 },
  personName: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: ink },
  personDetail: { fontSize: 12, color: inkMuted, marginTop: 3 },
  followButton: { minWidth: 94, minHeight: 44, paddingHorizontal: 13, borderRadius: 22, backgroundColor: primary, alignItems: 'center', justifyContent: 'center' },
  followingButton: { backgroundColor: '#E1ECDF', borderWidth: 1, borderColor: '#D1E2CE' },
  followText: { fontSize: 13, color: '#fff', fontWeight: '600' },
  followingText: { color: primary },
  moreButton: { width: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorBanner: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, marginBottom: 10, borderRadius: 16, backgroundColor: '#F5E9DF', gap: 8 },
  errorText: { flex: 1, fontSize: 13, lineHeight: 19, color: ink },
  retryButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 10 },
  retryText: { fontSize: 14, color: primary, fontWeight: '600' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingBottom: 90, gap: 13 },
  emptyIcon: { width: 78, height: 78, borderRadius: 28, backgroundColor: '#DFECDD', alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  emptyTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.6, color: ink, textAlign: 'center' },
  emptyDetail: { fontSize: 15, lineHeight: 22, color: inkMuted, textAlign: 'center' },
  discoverButton: { minHeight: 46, justifyContent: 'center', paddingHorizontal: 24, borderRadius: 23, backgroundColor: primary, marginTop: 9 },
  footer: { paddingVertical: 20, alignItems: 'center' },
  loadMore: { minHeight: 44, paddingHorizontal: 20, justifyContent: 'center', borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.7)' },
  confirmBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(23,40,32,0.25)', padding: 26 },
  confirmCard: { width: '100%', maxWidth: 350, padding: 24, borderRadius: 28, backgroundColor: 'rgba(248,250,243,0.96)' },
  confirmTitle: { fontSize: 22, fontWeight: '700', color: ink, letterSpacing: -0.6 },
  confirmDetail: { fontSize: 15, lineHeight: 22, color: inkMuted, marginTop: 12 },
  confirmActions: { flexDirection: 'row', gap: 10, marginTop: 24 },
  cancelButton: { flex: 1, minHeight: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E2EDDF' },
  removeButton: { flex: 1, minHeight: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: '#A54F42' },
});
