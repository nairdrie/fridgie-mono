// File: app/(main)/profile/[uid].tsx

import Cookbook from '@/components/Cookbook';
import { useAuth } from '@/context/AuthContext';
import { Recipe, UserProfile as UserProfileType } from '@/types/types';
import { followUser, getUserCookbook, getUserProfile, unfollowUser } from '@/utils/api';
import { primary } from '@/utils/styles'; // Assuming you have a primary color exported
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router'; // ✅ 1. Import useRouter
import { StatusBar as ESB } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Image,
    Platform,
    SafeAreaView,
    ScrollView, StatusBar, // ✅ 2. Import ScrollView
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from 'react-native';

// TODO: is cookbook clicks broken?

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
        return <View style={styles.centered}><ActivityIndicator size="large" /></View>;
    }

    if (!viewedUser) {
        return <SafeAreaView style={styles.centered}><Text>User not found.</Text></SafeAreaView>;
    }

    return (
        <>
            <ESB style="dark" />
            {/* ✅ 4. SafeAreaView handles the top padding automatically */}
            <SafeAreaView style={styles.container}>
                {/* ✅ 5. Your new custom header component */}
                <View style={styles.customHeader}>
                    <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
                        <Ionicons name="chevron-back" size={28} color={primary} />
                    </TouchableOpacity>
                    <Text style={styles.headerTitle}>{viewedUser?.displayName || 'Profile'}</Text>
                    <View style={styles.backButton} />{/* This is a spacer to keep the title centered */}
                </View>

                {/* ✅ 6. Wrap the content in a ScrollView so it scrolls under the header */}
                <ScrollView>
                    <View style={styles.profileContainer}>
                        <TouchableOpacity style={styles.profileImageContainer} disabled={true}>
                            {viewedUser?.photoURL ? (
                                <Image source={{ uri: viewedUser.photoURL }} style={styles.profileImage} />
                            ) : (
                                <View style={[styles.profileImage, styles.placeholderImage]}>
                                    <Ionicons name="person" size={60} color="#ccc" />
                                </View>
                            )}
                        </TouchableOpacity>
                        {viewedUser?.email && <Text style={styles.usernameText}>@{viewedUser.email.split('@')[0]}</Text>}
                    </View>

                     {!isOwnProfile && (
                        <View style={styles.actionContainer}>
                            <TouchableOpacity
                                style={[styles.followButton, viewedUser.isFollowing && styles.followingButton]}
                                onPress={handleFollowToggle}
                            >
                                <Text style={[styles.followButtonText, viewedUser.isFollowing && styles.followingButtonText]}>
                                    {viewedUser.isFollowing ? 'Following' : 'Follow'}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    )}

                     <View style={styles.statsContainer}>
                        <View style={styles.statItem}>
                            <Text style={styles.statNumber}>{viewedUser.followingCount || 0}</Text>
                            <Text style={styles.statLabel}>Following</Text>
                        </View>
                        <View style={styles.statItem}>
                            <Text style={styles.statNumber}>{viewedUser.followerCount || 0}</Text>
                            <Text style={styles.statLabel}>Followers</Text>
                        </View>
                        <View style={styles.statItem}>
                            <Text style={styles.statNumber}>{cookbook.length || 0}</Text>
                            <Text style={styles.statLabel}>Recipes</Text>
                        </View>
                    </View>

                    <View style={styles.feedContainer}>
                        <Cookbook
                            recipes={cookbook}
                            isLoading={isCookbookLoading}
                            onRefresh={fetchCookbook}
                        />
                    </View>
                </ScrollView>
            </SafeAreaView>
        </>
    );
}

const styles = StyleSheet.create({
    // ✅ 7. Add new styles for your custom header
    customHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 10,
        paddingVertical: 12,
        backgroundColor: '#f8f9fa', // Match container background
    },
    backButton: {
        width: 40, // Provides a larger tap area
        padding: 5,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: 'bold',
    },
    // --- Other styles remain the same ---
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    container: {
        flex: 1,
        backgroundColor: '#f8f9fa',
        paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
    },
    profileContainer: {
        alignItems: 'center',
        paddingTop: 12, // Reduced padding since header has its own
        paddingBottom: 24,
    },
    profileImageContainer: {
        marginBottom: 16,
    },
    profileImage: {
        width: 120,
        height: 120,
        borderRadius: 60,
        borderWidth: 3,
        borderColor: '#fff',
    },
    placeholderImage: {
        backgroundColor: '#e9ecef',
        justifyContent: 'center',
        alignItems: 'center',
    },
    displayName: {
        fontSize: 24,
        fontWeight: '800',
        color: '#333',
        marginBottom: 4,
    },
    usernameText: {
        fontSize: 16,
        color: '#6c757d',
        marginBottom: 16,
    },
    statsContainer: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        paddingVertical: 16,
        marginHorizontal: 16,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: '#e9ecef',
    },
    statItem: {
        alignItems: 'center',
    },
    statNumber: {
        fontSize: 18,
        fontWeight: 'bold',
    },
    statLabel: {
        fontSize: 14,
        color: '#6c757d',
        marginTop: 4,
    },
    feedContainer: {
        paddingHorizontal: 16,
        // The flex: 1 is no longer needed here as ScrollView handles the layout
        paddingTop: 16,
        paddingBottom: 32, // Add padding at the bottom
    },
    actionContainer: {
        paddingHorizontal: 16,
        paddingBottom: 20,
    },
    followButton: {
        backgroundColor: primary,
        paddingVertical: 12,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    followButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 'bold',
    },
    followingButton: {
        backgroundColor: '#e9ecef',
        borderWidth: 1,
        borderColor: '#dee2e6',
    },
    followingButtonText: {
        color: '#495057',
    },
});