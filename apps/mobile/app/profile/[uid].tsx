import { AmbientBackground, GlassPressable as TouchableOpacity, GlassSurface } from '@/components/ui/Glass';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';
// File: app/(main)/profile/[uid].tsx

import Cookbook from '@/components/Cookbook';
import { CreatorAvatar, CuratedBadge, discoveryAccents } from '@/components/discover/DiscoverCards';
import { useAuth } from '@/context/AuthContext';
import { Recipe, UserProfile as UserProfileType } from '@/types/types';
import { followUser, getUserCookbook, getUserProfile, unfollowUser } from '@/utils/api';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar as ESB } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Image,
    Platform,
    SafeAreaView,
    StatusBar,
    StyleSheet,
    Text,
    View
} from 'react-native';

export default function OtherUserProfileScreen() {
    const { uid } = useLocalSearchParams<{ uid: string }>();
    const router = useRouter();
    const { user: currentUser } = useAuth(); // Get the currently logged-in user

    const [viewedUser, setViewedUser] = useState<UserProfileType | null>(null);
    const [cookbook, setCookbook] = useState<Recipe[]>([]);
    const [loading, setLoading] = useState(true);
    const [isCookbookLoading, setIsCookbookLoading] = useState(true);

    const [isFollowPending, setIsFollowPending] = useState(false);
    const profileRequestVersion = useRef(0);
    const cookbookRequestVersion = useRef(0);
    const loadedProfileKey = useRef<string | null>(null);
    const pendingFollowUid = useRef<string | null>(null);
    const focusedUid = useRef<string | null>(null);
    const activeUid = useRef(uid);
    const mounted = useRef(true);
    activeUid.current = uid;
    const viewerUid = currentUser?.uid;
    const isOwnProfile = viewerUid === uid;

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const loadProfile = useCallback(async () => {
        if (!uid) {
            setLoading(false);
            return;
        }
        // The mutation's optimistic state remains visible until it settles;
        // its finally block then reads the server again if this screen is focused.
        if (pendingFollowUid.current === uid) return;
        const requestVersion = ++profileRequestVersion.current;
        const cookbookVersion = ++cookbookRequestVersion.current;
        const profileKey = `${viewerUid ?? 'guest'}:${uid}`;
        const isInitialLoad = loadedProfileKey.current !== profileKey;
        if (isInitialLoad) {
            setLoading(true);
            setIsCookbookLoading(true);
            setViewedUser(null);
            setCookbook([]);
        }
        try {
            const [profileData, userCookbook] = await Promise.all([
                getUserProfile(uid),
                getUserCookbook(uid),
            ]);
            if (requestVersion !== profileRequestVersion.current) return;
            loadedProfileKey.current = profileKey;
            setViewedUser(profileData as UserProfileType);
            if (cookbookVersion === cookbookRequestVersion.current) setCookbook(userCookbook);
        } catch (error) {
            if (requestVersion !== profileRequestVersion.current) return;
            console.error('Failed to fetch user data:', error);
            if (isInitialLoad) Alert.alert('Error', 'Could not load user profile.');
        } finally {
            if (requestVersion === profileRequestVersion.current) setLoading(false);
            if (cookbookVersion === cookbookRequestVersion.current) setIsCookbookLoading(false);
        }
    }, [uid, viewerUid]);

    useFocusEffect(useCallback(() => {
        focusedUid.current = uid;
        void loadProfile();
        return () => {
            focusedUid.current = null;
            profileRequestVersion.current += 1;
            cookbookRequestVersion.current += 1;
        };
    }, [uid, loadProfile]));

    const handleFollowToggle = async () => {
        if (!viewedUser || !uid || pendingFollowUid.current) return;
        const targetUid = uid;
        const originalUser = viewedUser;
        pendingFollowUid.current = targetUid;
        setIsFollowPending(true);
        // A focus refresh started before this tap must not overwrite the
        // optimistic relationship with its older server snapshot.
        profileRequestVersion.current += 1;
        setViewedUser({
            ...originalUser,
            isFollowing: !originalUser.isFollowing,
            followerCount: Math.max(0, (originalUser.followerCount || 0) + (originalUser.isFollowing ? -1 : 1)),
        });

        try {
            if (originalUser.isFollowing) await unfollowUser(targetUid);
            else await followUser(targetUid);
        } catch (error) {
            console.error('Follow/unfollow failed:', error);
            if (mounted.current && activeUid.current === targetUid) {
                setViewedUser(originalUser);
                Alert.alert('Error', 'An error occurred. Please try again.');
            }
        } finally {
            pendingFollowUid.current = null;
            if (mounted.current) {
                setIsFollowPending(false);
                if (focusedUid.current === targetUid) void loadProfile();
            }
        }
    };

    const fetchCookbook = async () => {
        if (!uid) return;
        const requestVersion = ++cookbookRequestVersion.current;
        try {
            setIsCookbookLoading(true);
            const userCookbook = await getUserCookbook(uid);
            if (requestVersion === cookbookRequestVersion.current) setCookbook(userCookbook);
        } catch (error) {
            if (requestVersion === cookbookRequestVersion.current) console.error('Failed to fetch cookbook:', error);
        } finally {
            if (requestVersion === cookbookRequestVersion.current) setIsCookbookLoading(false);
        }
    };

    if (loading) {
        return <View style={styles.centered}><ActivityIndicator size="large" color={primary} /></View>;
    }

    if (!viewedUser) {
        return <SafeAreaView style={styles.centered}><Text style={styles.notFoundTitle}>This kitchen is unavailable</Text><TouchableOpacity style={styles.followButton} onPress={() => router.back()}><Text style={styles.followButtonText}>Go back</Text></TouchableOpacity></SafeAreaView>;
    }

    const isCurated = viewedUser.profileKind === 'curated';
    const profileAccent = discoveryAccents[viewedUser.accent ?? 'sage'];
    const handle = viewedUser.handle || (!isCurated ? viewedUser.email?.split('@')[0] : null);

    return (
        <AmbientBackground>
            <ESB style="dark" />
            <SafeAreaView style={styles.container}>
                <View style={styles.customHeader}>
                    <GlassSurface style={styles.backGlass}><TouchableOpacity style={styles.backButton} onPress={() => router.back()} accessibilityLabel="Go back">
                        <Ionicons name="chevron-back" size={22} color="#173F35" />
                    </TouchableOpacity></GlassSurface>
                    <Text style={styles.headerTitle}>{isOwnProfile ? 'Your kitchen' : isCurated ? 'A Fridgie kitchen' : 'A seat at the table'}</Text>
                    <View style={styles.backButton} />
                </View>
                <Cookbook
                    recipes={cookbook}
                    isLoading={isCookbookLoading}
                    onRefresh={fetchCookbook}
                    isOwnCookbook={isOwnProfile}
                    contentContainerStyle={styles.cookbookContent}
                    header={<>
                    <Animated.View entering={FadeInDown.duration(500).reduceMotion(ReduceMotion.System)}>
                    <GlassSurface style={styles.profileContainer} intensity={50}>
                        <View style={[styles.profileAccent, isCurated && { backgroundColor: profileAccent.background }]} />
                        <View style={styles.profileImageContainer}>
                            {isCurated ? <CreatorAvatar name={viewedUser.displayName || 'Fridgie'} photoURL={viewedUser.photoURL} accent={viewedUser.accent} size={96} /> : viewedUser?.photoURL ? (
                                <Image source={{ uri: viewedUser.photoURL }} style={styles.profileImage} />
                            ) : (
                                <View style={[styles.profileImage, styles.placeholderImage]}><Ionicons name="person" size={42} color="#789787" /></View>
                            )}
                        </View>
                        {isCurated && <View style={styles.curatedLabel}><CuratedBadge /></View>}
                        <Text style={styles.displayName}>{viewedUser.displayName || 'Fridgie cook'}</Text>
                        {!!handle && <Text style={styles.usernameText}>@{handle.replace(/^@/, '')}</Text>}
                        {!!viewedUser.specialty && <Text style={styles.specialty}>{viewedUser.specialty}</Text>}
                        {!!viewedUser.bio && <Text style={styles.bio}>{viewedUser.bio}</Text>}
                        {isCurated && <Text style={styles.curatedNote}>A fictional kitchen from Fridgie, with AI-created recipes.</Text>}
                        {!isOwnProfile && (
                            <View style={styles.actionContainer}>
                                <TouchableOpacity
                                    style={[styles.followButton, viewedUser.isFollowing && styles.followingButton]}
                                    onPress={handleFollowToggle}
                                    accessibilityLabel={viewedUser.isFollowing ? `Unfollow ${viewedUser.displayName}` : `Follow ${viewedUser.displayName}`}
                                    accessibilityState={{ selected: !!viewedUser.isFollowing, busy: isFollowPending }}
                                    disabled={isFollowPending}
                                >
                                    {isFollowPending ? <ActivityIndicator size="small" color={viewedUser.isFollowing ? primary : '#FFFFFF'} /> : <Ionicons name={viewedUser.isFollowing ? 'checkmark' : 'add'} size={18} color={viewedUser.isFollowing ? primary : '#FFFFFF'} />}
                                    <Text style={[styles.followButtonText, viewedUser.isFollowing && styles.followingButtonText]}>
                                        {viewedUser.isFollowing ? 'Following' : isCurated ? 'Follow kitchen' : 'Follow'}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        )}
                        <View style={styles.statsContainer}>
                            {!isCurated && <TouchableOpacity style={styles.statItem} onPress={() => router.push({ pathname: '/profile/connections', params: { uid, kind: 'following' } })} accessibilityLabel={`View ${viewedUser.followingCount || 0} people ${viewedUser.displayName || 'this cook'} follows`}><Text style={styles.statNumber}>{viewedUser.followingCount || 0}</Text><Text style={styles.statLabel}>Following</Text></TouchableOpacity>}
                            <TouchableOpacity style={[styles.statItem, styles.statDivider]} onPress={() => router.push({ pathname: '/profile/connections', params: { uid, kind: 'followers' } })} accessibilityLabel={`View ${viewedUser.displayName || 'this cook'}’s ${viewedUser.followerCount || 0} followers`}><Text style={styles.statNumber}>{viewedUser.followerCount || 0}</Text><Text style={styles.statLabel}>Followers</Text></TouchableOpacity>
                            <View style={styles.statItem}><Text style={styles.statNumber}>{cookbook.length || 0}</Text><Text style={styles.statLabel}>Recipes</Text></View>
                        </View>
                    </GlassSurface>
                    </Animated.View>
                    <View style={styles.feedContainer}>
                        <View style={styles.cookbookHeader}><Text style={styles.cookbookTitle}>The cookbook</Text><Text style={styles.recipeCount}>{cookbook.length} recipes</Text></View>
                    </View>
                    </>}
                />
            </SafeAreaView>
        </AmbientBackground>
    );
}

const styles = StyleSheet.create({
    customHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, paddingTop: 14, paddingBottom: 22 },
    backGlass: { borderRadius: 20 },
    backButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    headerTitle: { fontSize: 15, fontWeight: '600', letterSpacing: -0.2, color: '#173F35' },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F5F5EF', padding: 24 },
    notFoundTitle: { fontSize: 23, fontWeight: '600', color: '#173F35', marginBottom: 24, textAlign: 'center' },
    container: { flex: 1, backgroundColor: 'transparent', paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
    cookbookContent: { paddingHorizontal: 22 },
    profileContainer: { alignItems: 'center', paddingTop: 28, paddingBottom: 8, borderRadius: 30, overflow: 'hidden' },
    profileAccent: { position: 'absolute', width: 280, height: 280, borderRadius: 140, backgroundColor: 'rgba(220,237,226,0.6)', top: -185, right: -90 },
    profileImageContainer: { marginBottom: 14 },
    profileImage: { width: 96, height: 96, borderRadius: 38, borderWidth: 3, borderColor: '#FFFFFF' },
    placeholderImage: { backgroundColor: '#DCEDE2', justifyContent: 'center', alignItems: 'center' },
    displayName: { fontSize: 28, fontWeight: '700', letterSpacing: -0.8, color: '#173F35', marginBottom: 4, paddingHorizontal: 20, textAlign: 'center' },
    usernameText: { fontSize: 14, color: '#78857D', marginBottom: 14 },
    curatedLabel: { alignItems: 'center', marginBottom: 13 },
    specialty: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: primary, textAlign: 'center', paddingHorizontal: 24, marginBottom: 9 },
    bio: { fontSize: 13, lineHeight: 21, color: '#687A70', textAlign: 'center', paddingHorizontal: 26, marginBottom: 13 },
    curatedNote: { fontSize: 11, lineHeight: 17, color: '#687A70', textAlign: 'center', paddingHorizontal: 29, marginBottom: 18 },
    statsContainer: { flexDirection: 'row', width: '100%', paddingVertical: 18, marginTop: 4 },
    statItem: { flex: 1, alignItems: 'center' },
    statDivider: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: '#E1E8DC' },
    statNumber: { fontSize: 23, fontWeight: '700', letterSpacing: -0.6, color: '#173F35' },
    statLabel: { fontSize: 11, color: '#78857D', marginTop: 5, fontWeight: '500' },
    feedContainer: { paddingTop: 28 },
    cookbookHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
    cookbookTitle: { fontSize: 25, fontWeight: '700', letterSpacing: -0.8, color: '#173F35' },
    recipeCount: { fontSize: 12, color: '#78857D' },
    actionContainer: { alignSelf: 'stretch', paddingHorizontal: 24, paddingTop: 4, paddingBottom: 6 },
    followButton: { backgroundColor: primary, paddingVertical: 13, paddingHorizontal: 24, borderRadius: 18, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7 },
    followButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
    followingButton: { backgroundColor: '#E3EEE0', borderWidth: 1, borderColor: '#CDE0CE' },
    followingButtonText: { color: primary },
});
