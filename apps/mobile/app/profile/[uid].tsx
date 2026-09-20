import { AmbientBackground, GlassPressable as TouchableOpacity, GlassSurface } from '@/components/ui/Glass';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';
// File: app/(main)/profile/[uid].tsx

import Cookbook from '@/components/Cookbook';
import { useAuth } from '@/context/AuthContext';
import { Recipe, UserProfile as UserProfileType } from '@/types/types';
import { followUser, getUserCookbook, getUserProfile, unfollowUser } from '@/utils/api';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar as ESB } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Image,
    Platform,
    SafeAreaView,
    ScrollView, StatusBar,
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

    const isOwnProfile = currentUser?.uid === uid;

    useEffect(() => {
        if (!uid) return;
        const fetchUserData = async () => {
            try {
                setLoading(true);
                const [profileData, userCookbook] = await Promise.all([
                    getUserProfile(uid),
                    getUserCookbook(uid)
                ]);
                setViewedUser(profileData as UserProfileType);
                setCookbook(userCookbook);
            } catch (error) {
                console.error("Failed to fetch user data:", error);
                Alert.alert("Error", "Could not load user profile.");
            } finally {
                setLoading(false);
                setIsCookbookLoading(false);
            }
        };
        fetchUserData();
    }, [uid]);

    const handleFollowToggle = async () => {
        if (!viewedUser) return;

        // Optimistic UI update for instant feedback
        const originalUser = viewedUser;
        setViewedUser(prev => {
            if (!prev) return null;
            const isFollowing = !prev.isFollowing;
            const followerCount = isFollowing
                ? (prev.followerCount || 0) + 1
                : (prev.followerCount || 0) - 1;
            return { ...prev, isFollowing, followerCount };
        });

        try {
            if (originalUser.isFollowing) {
                await unfollowUser(uid!);
            } else {
                await followUser(uid!);
            }
        } catch (error) {
            console.error("Follow/unfollow failed:", error);
            // Revert state on failure
            setViewedUser(originalUser);
            Alert.alert("Error", "An error occurred. Please try again.");
        }
    };

    const fetchCookbook = async () => {
        if (!uid) return;
        try {
            setIsCookbookLoading(true);
            const userCookbook = await getUserCookbook(uid);
            setCookbook(userCookbook);
        } catch (error) {
            console.error("Failed to fetch cookbook:", error);
        } finally {
            setIsCookbookLoading(false);
        }
    };

    if (loading) {
        return <View style={styles.centered}><ActivityIndicator size="large" color={primary} /></View>;
    }

    if (!viewedUser) {
        return <SafeAreaView style={styles.centered}><Text style={styles.notFoundTitle}>This kitchen is unavailable</Text><TouchableOpacity style={styles.followButton} onPress={() => router.back()}><Text style={styles.followButtonText}>Go back</Text></TouchableOpacity></SafeAreaView>;
    }

    return (
        <AmbientBackground>
            <ESB style="dark" />
            <SafeAreaView style={styles.container}>
                <View style={styles.customHeader}>
                    <GlassSurface style={styles.backGlass}><TouchableOpacity style={styles.backButton} onPress={() => router.back()} accessibilityLabel="Go back">
                        <Ionicons name="chevron-back" size={22} color="#173F35" />
                    </TouchableOpacity></GlassSurface>
                    <Text style={styles.headerTitle}>{isOwnProfile ? 'Your kitchen' : 'A seat at the table'}</Text>
                    <View style={styles.backButton} />
                </View>
                <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
                    <Animated.View entering={FadeInDown.duration(500).reduceMotion(ReduceMotion.System)}>
                    <GlassSurface style={styles.profileContainer} intensity={50}>
                        <View style={styles.profileAccent} />
                        <View style={styles.profileImageContainer}>
                            {viewedUser?.photoURL ? (
                                <Image source={{ uri: viewedUser.photoURL }} style={styles.profileImage} />
                            ) : (
                                <View style={[styles.profileImage, styles.placeholderImage]}><Ionicons name="person" size={42} color="#789787" /></View>
                            )}
                        </View>
                        <Text style={styles.displayName}>{viewedUser.displayName || 'Fridgie cook'}</Text>
                        {viewedUser?.email && <Text style={styles.usernameText}>@{viewedUser.email.split('@')[0]}</Text>}
                        {!isOwnProfile && (
                            <View style={styles.actionContainer}>
                                <TouchableOpacity
                                    style={[styles.followButton, viewedUser.isFollowing && styles.followingButton]}
                                    onPress={handleFollowToggle}
                                    accessibilityLabel={viewedUser.isFollowing ? `Unfollow ${viewedUser.displayName}` : `Follow ${viewedUser.displayName}`}
                                    accessibilityState={{ selected: !!viewedUser.isFollowing }}
                                >
                                    <Ionicons name={viewedUser.isFollowing ? 'checkmark' : 'add'} size={18} color={viewedUser.isFollowing ? primary : '#FFFFFF'} />
                                    <Text style={[styles.followButtonText, viewedUser.isFollowing && styles.followingButtonText]}>
                                        {viewedUser.isFollowing ? 'Following' : 'Follow'}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        )}
                        <View style={styles.statsContainer}>
                            <View style={styles.statItem}><Text style={styles.statNumber}>{viewedUser.followingCount || 0}</Text><Text style={styles.statLabel}>Following</Text></View>
                            <View style={[styles.statItem, styles.statDivider]}><Text style={styles.statNumber}>{viewedUser.followerCount || 0}</Text><Text style={styles.statLabel}>Followers</Text></View>
                            <View style={styles.statItem}><Text style={styles.statNumber}>{cookbook.length || 0}</Text><Text style={styles.statLabel}>Recipes</Text></View>
                        </View>
                    </GlassSurface>
                    </Animated.View>
                    <View style={styles.feedContainer}>
                        <View style={styles.cookbookHeader}><Text style={styles.cookbookTitle}>The cookbook</Text><Text style={styles.recipeCount}>{cookbook.length} recipes</Text></View>
                        <Cookbook
                            recipes={cookbook}
                            isLoading={isCookbookLoading}
                            onRefresh={fetchCookbook}
                            isOwnCookbook={isOwnProfile}
                        />
                    </View>
                </ScrollView>
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
    scrollContent: { paddingHorizontal: 22, paddingBottom: 40 },
    profileContainer: { alignItems: 'center', paddingTop: 28, paddingBottom: 8, borderRadius: 30, overflow: 'hidden' },
    profileAccent: { position: 'absolute', width: 280, height: 280, borderRadius: 140, backgroundColor: 'rgba(220,237,226,0.6)', top: -185, right: -90 },
    profileImageContainer: { marginBottom: 14 },
    profileImage: { width: 96, height: 96, borderRadius: 38, borderWidth: 3, borderColor: '#FFFFFF' },
    placeholderImage: { backgroundColor: '#DCEDE2', justifyContent: 'center', alignItems: 'center' },
    displayName: { fontSize: 28, fontWeight: '700', letterSpacing: -0.8, color: '#173F35', marginBottom: 4, paddingHorizontal: 20, textAlign: 'center' },
    usernameText: { fontSize: 14, color: '#78857D', marginBottom: 14 },
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
