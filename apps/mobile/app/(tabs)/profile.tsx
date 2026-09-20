import { AmbientBackground, GlassPressable as TouchableOpacity, GlassSurface, useGlassPreferences } from '@/components/ui/Glass';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';
import AddEditRecipeModal from '@/components/AddEditRecipeModal';
import AddToMealPlanModal from '@/components/AddToMealPlanModal';
import CookbookFilterBar, { CookbookGroupHeader } from '@/components/CookbookFilterBar';
import NotificationBell from '@/components/NotificationBell';
import NotificationsModal from '@/components/NotificationsModal';
import RecipeCard from '@/components/RecipeCard';
import ViewRecipeModal from '@/components/ViewRecipeModal';
import { useAuth } from '@/context/AuthContext';
import { useCookbook } from '@/context/CookbookContext';
import { useNotifications } from '@/context/NotificationContext';
import { useCookbookFilter } from '@/hooks/useCookbookFilter';
import { useKeyboardAwareScroll } from '@/hooks/useKeyboardAwareScroll';
import { Item, Meal, Recipe } from '@/types/types';
import { getUserCookbook, getUserProfile, uploadUserPhoto } from '@/utils/api';
import { defaultAvatars } from '@/utils/defaultAvatars';
import { clearCache } from '@/utils/listCache';
import { flushAllDirty, resetSyncEngines } from '@/utils/listSync';
import { auth } from '@/utils/firebase';
import { primary } from '@/utils/styles';
import { toReadablePhone } from '@/utils/utils';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { updateEmail, updateProfile, User } from 'firebase/auth';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Image,
    Modal,
    NativeScrollEvent,
    NativeSyntheticEvent,
    KeyboardAvoidingView,
    Platform,
    RefreshControl,
    SafeAreaView,
    StatusBar as SB,
    ScrollView,
    SectionList,
    StyleSheet,
    Text,
    TextInput,
    View
} from 'react-native';

// --- Sub-components for Modals (kept here for completeness) ---

const EditableInfoRow = ({ label, value, onSave, showLabel = true, size = 16, bold = false, editable = true, placeholder = "" }: { placeholder?: string, editable?: boolean, label: string; value: string; showLabel?: boolean; onSave: (newValue: string) => Promise<void>, size?: number, bold?: boolean }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [text, setText] = useState(value);
    const [loading, setLoading] = useState(false);

    const handleSave = async () => {
        setLoading(true);
        try {
            await onSave(text);
            setIsEditing(false);
        } catch (error: any) {
            Alert.alert("Error", error.message || `Could not update ${label}.`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <View style={styles.infoRow}>
            {showLabel && <Text style={styles.infoLabel}>{label}</Text>}
            {isEditing ? (
                <View style={styles.editContainer}>
                    <TextInput
                        style={styles.infoInput}
                        value={text}
                        onChangeText={setText}
                        autoFocus
                        placeholder={placeholder}
                    />
                    <TouchableOpacity style={styles.inlineButton} onPress={handleSave} disabled={loading}>
                        <Text style={styles.inlineButtonText}>Save</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.inlineButtonSecondary} onPress={() => setIsEditing(false)}>
                        <Text style={styles.inlineButtonSecondaryText}>Cancel</Text>
                    </TouchableOpacity>
                </View>
            ) : (
                <View style={styles.viewContainer}>
                    <Text style={[styles.infoValue, { fontSize: size, fontWeight: bold ? '800' : '600' }]}>{value}</Text>
                    {editable &&
                        <TouchableOpacity style={styles.editPencilButton} onPress={() => { setText(value); setIsEditing(true); }}>
                            <Ionicons name="pencil" size={14} color="#fff" />
                        </TouchableOpacity>
                    }
                </View>
            )}
        </View>
    );
};

const SettingsModal = ({ isVisible, onClose, onNavigate, onDismiss }: { isVisible: boolean; onClose: () => void; onNavigate: (path: string) => void; onDismiss: () => void }) => {
    const { reduceMotion } = useGlassPreferences();
    const router = useRouter();
    const { user, refreshAuthUser } = useAuth();
    // A row only grows a text field once you tap Edit, so which of them is being
    // typed into is not known ahead of time — the scroller hears all of them.
    const keyboard = useKeyboardAwareScroll({ enabled: isVisible });

    const handleEmailSave = async (newEmail: string) => {
        const userToUpdate = auth.currentUser;
        if (!userToUpdate) throw new Error("User not found");
        try {
            await updateEmail(userToUpdate, newEmail);
            refreshAuthUser();
        } catch (error) {
            throw new Error("Failed to update email. You may need to sign out and sign back in.");
        }
    };

    return (
        <Modal visible={isVisible} animationType={reduceMotion ? "none" : "slide"} presentationStyle="pageSheet" onRequestClose={onClose} onDismiss={onDismiss}>
            <KeyboardAvoidingView
                style={styles.modalViewContainer}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
            <SafeAreaView style={styles.modalViewContainer}>
                <View style={styles.modalHeader}>
                    <Text style={styles.modalHeaderTitle}>Settings</Text>
                    <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                        <Ionicons name="close-circle-outline" size={30} color={primary} />
                    </TouchableOpacity>
                </View>
                {/* Without persistTaps the first tap on an editable row's Save
                    button is swallowed dismissing the keyboard, so saving a name
                    takes two taps and looks like the button does nothing. */}
                <ScrollView
                    ref={keyboard.scrollRef}
                    {...keyboard.scrollProps}
                    style={styles.modalScrollView}
                    contentContainerStyle={{ paddingBottom: keyboard.keyboardSpace }}
                    keyboardShouldPersistTaps="handled"
                >
                    <Text style={styles.sectionTitle}>Profile Information</Text>
                    <EditableInfoRow
                        label="Name"
                        value={user?.displayName || 'Set Your Name'}
                        onSave={async (name) => {
                            const userToUpdate = auth.currentUser;
                            if (!userToUpdate) throw new Error("User not found");
                            await updateProfile(userToUpdate, { displayName: name });
                            refreshAuthUser();
                        }}
                    />
                    {user?.phoneNumber &&
                        <EditableInfoRow
                            label="Phone Number"
                            value={toReadablePhone(user?.phoneNumber) || 'Not set'}
                            onSave={async () => {}}
                            editable={false}
                        />
                    }
                    {user?.email &&
                        <EditableInfoRow
                            label="Email"
                            value={user?.email || 'Not set'}
                            onSave={handleEmailSave}
                        />
                    }
                    <Text style={styles.sectionTitle}>Preferences</Text>
                    <TouchableOpacity style={styles.manageGroups} onPress={() => onNavigate('/groups')}>
                        <Ionicons name="people" size={16} color={primary}></Ionicons>
                        <Text style={styles.editMealPreferencesText}>Manage Groups</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.editMealPreferences} onPress={() => onNavigate('/meal-preferences')}>
                        <Ionicons name="open-outline" size={16} color={primary}></Ionicons>
                        <Text style={styles.editMealPreferencesText}>Edit Meal Preferences</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.primaryButton, { marginTop: 30, width: '100%' }]} onPress={() => {
                        // Push anything still owed to the server BEFORE signing
                        // out, then wipe the on-device mirror. Both halves
                        // matter: skipping the flush throws away edits made
                        // offline, and skipping the clear leaves one account's
                        // groceries on the phone for whoever signs in next.
                        //
                        // Not awaited — sign-out should not hang on a network
                        // the user may well not have. The flush gets its chance;
                        // if it fails, the clear takes the edits with it, which
                        // is the correct trade for an explicit sign-out.
                        void flushAllDirty()
                            .catch(() => {})
                            .finally(() => {
                                resetSyncEngines();
                                void clearCache();
                            });
                        auth.signOut();
                        router.navigate('/list');
                        onClose();
                    }}>
                        <Text style={styles.primaryButtonText}>Sign Out</Text>
                    </TouchableOpacity>
                </ScrollView>
            </SafeAreaView>
            </KeyboardAvoidingView>
        </Modal>
    );
};

const ProfileHeader = ({ 
    authUser, 
    cookbook, 
    openPhotoModal, 
    openNotifications, 
    setSettingsModalVisible,
    followerCount,
    followingCount
 }: {
    authUser: User, 
    cookbook: Recipe[], 
    openPhotoModal: any, 
    openNotifications: () => void, 
    setSettingsModalVisible: any,
    followerCount: number,
    followingCount: number,
}) => (
    <Animated.View entering={FadeInDown.duration(550).reduceMotion(ReduceMotion.System)}>
        <View style={styles.pageHeading}>
            <View><Text style={styles.eyebrow}>MAKE YOURSELF AT HOME</Text><Text style={styles.pageTitle}>Your kitchen</Text></View>
            <View style={styles.headerButtons}>
                <NotificationBell onPress={openNotifications} />
                <GlassSurface style={styles.settingsGlass}>
                    <TouchableOpacity onPress={() => setSettingsModalVisible(true)} style={styles.settingsButton} accessibilityLabel="Open settings">
                        <Ionicons name="settings-outline" size={22} color="#173F35" />
                    </TouchableOpacity>
                </GlassSurface>
            </View>
        </View>
        <GlassSurface style={styles.profileContainer} intensity={50}>
            <View style={styles.profileAccent} />
            <TouchableOpacity onPress={openPhotoModal} style={styles.profileImageContainer} accessibilityLabel="Change your profile photo">
                {authUser?.photoURL ? (
                    <Image source={{ uri: authUser.photoURL }} style={styles.profileImage} />
                ) : (
                    <View style={[styles.profileImage, styles.placeholderImage]}><Ionicons name="person" size={42} color="#789787" /></View>
                )}
                <View style={styles.editIconContainer}><Ionicons name="pencil" size={13} color="#fff" /></View>
            </TouchableOpacity>
            <Text style={styles.displayName}>{authUser?.displayName || 'Fridgie User'}</Text>
            {authUser?.email && <Text style={styles.usernameText}>@{authUser.email.split('@')[0]}</Text>}
            <View style={styles.statsContainer}>
                <View style={styles.statItem}><Text style={styles.statNumber}>{followingCount || 0}</Text><Text style={styles.statLabel}>Following</Text></View>
                <View style={[styles.statItem, styles.statDivider]}><Text style={styles.statNumber}>{followerCount || 0}</Text><Text style={styles.statLabel}>Followers</Text></View>
                <View style={styles.statItem}><Text style={styles.statNumber}>{cookbook.length || 0}</Text><Text style={styles.statLabel}>Recipes</Text></View>
            </View>
        </GlassSurface>
    </Animated.View>
);


// --- Main Profile Component ---

export default function UserProfile() {
    const { reduceMotion } = useGlassPreferences();
    const { user: authUser, refreshAuthUser } = useAuth();
    const { addRecipe, removeRecipe } = useCookbook();
    const router = useRouter();

    const [editPhotoModalVisible, setEditPhotoModalVisible] = useState(false);
    const [settingsModalVisible, setSettingsModalVisible] = useState(false);
    const [newPhotoUri, setNewPhotoUri] = useState<string | null>(null);
    const { notifications, isLoading: isNotificationsLoading, acceptInvitation, declineInvitation, markAllRead } = useNotifications();
    const [isNotificationsVisible, setNotificationsVisible] = useState(false);

    // Opening the list is what counts as seeing them: the badge clears here,
    // while the notifications themselves stay on screen to be read.
    const openNotifications = useCallback(() => {
        setNotificationsVisible(true);
        markAllRead();
    }, [markAllRead]);

    const [profileData, setProfileData] = useState<{ followerCount: number, followingCount: number } | null>(null);

    const flatListRef = useRef<FlatList | null>(null);
    const [isAtStart, setIsAtStart] = useState(true);
    const [isAtEnd, setIsAtEnd] = useState(false);
    const carouselData = [...defaultAvatars, 'upload'];
    
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [cookbook, setCookbook] = useState<Recipe[]>([]);
    const [isCookbookLoading, setIsCookbookLoading] = useState(true);

    const [isDataLoading, setIsDataLoading] = useState(true);

    const [isMealPlanModalVisible, setIsMealPlanModalVisible] = useState(false);
    const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
    // The recipe the editor is open on; the flag is the same editor opened on
    // nothing, for one written from scratch. Either way what comes out goes on
    // the cookbook shelf rather than into a week's meal plan.
    const [recipeToEdit, setRecipeToEdit] = useState<Recipe | null>(null);
    const [isAddingRecipe, setIsAddingRecipe] = useState(false);

    const [recipeToViewId, setRecipeToViewId] = useState<string | null>(null);
    
    // Settings is a native modal, so a route pushed from inside it lands *behind*
    // it and the tap looks like a no-op. Dismiss Settings first, push on the way
    // out, then reopen it when that screen pops — so Settings reads as a step in
    // the nav stack and back returns to it.
    const pendingSettingsRoute = useRef<string | null>(null);
    const shouldReopenSettings = useRef(false);

    const flushPendingSettingsRoute = useCallback(() => {
        const path = pendingSettingsRoute.current;
        if (!path) return;
        pendingSettingsRoute.current = null;
        shouldReopenSettings.current = true;
        router.push(path as any);
    }, [router]);

    const handleSettingsNavigate = useCallback((path: string) => {
        pendingSettingsRoute.current = path;
        setSettingsModalVisible(false);
        // onDismiss is iOS-only; elsewhere the dismissal is immediate enough to
        // push right away.
        if (Platform.OS !== 'ios') flushPendingSettingsRoute();
    }, [flushPendingSettingsRoute]);

    const [isFocused, setIsFocused] = useState(false);
    useFocusEffect(
        useCallback(() => {
            setIsFocused(true);
            if (shouldReopenSettings.current) {
                shouldReopenSettings.current = false;
                setSettingsModalVisible(true);
            }
            return () => setIsFocused(false);
        }, [])
    );

    const fetchProfileData = useCallback(async () => {
        if (!authUser || authUser.isAnonymous) {
            setIsDataLoading(false);
            return;
        };
        
        try {
            // Fetch profile info and cookbook in parallel for speed
            const [userProfile, userCookbook] = await Promise.all([
                getUserProfile(authUser.uid),
                getUserCookbook(authUser.uid)
            ]);

            setProfileData(userProfile as any);
            setCookbook(userCookbook);
        } catch (error) {
            console.error("Failed to fetch profile data:", error);
            Alert.alert("Error", "Could not load your profile information.");
        }
    }, [authUser]);

    const loadData = useCallback(async (isRefresh = false) => {
        if (isRefresh) {
            setIsRefreshing(true);
        } else {
            setIsDataLoading(true);
        }
        
        await fetchProfileData();

        if (isRefresh) {
            setIsRefreshing(false);
        } else {
            setIsDataLoading(false);
        }
    }, [fetchProfileData]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    const filter = useCookbookFilter(cookbook);

    const handleAccept = (invitationId: string) => {
        acceptInvitation(invitationId, () => {
            refreshAuthUser();
            setNotificationsVisible(false);
            router.navigate('/groups');
        });
    };

    const handleDecline = (invitationId: string) => declineInvitation(invitationId);

    const handleEditRecipe = (recipe: Recipe) => {
        setRecipeToViewId(null);
        setIsAddingRecipe(false);
        setRecipeToEdit(recipe);
    };

    const handleAddRecipe = () => {
        setRecipeToEdit(null);
        setIsAddingRecipe(true);
    };

    const closeRecipeEditor = () => {
        setRecipeToEdit(null);
        setIsAddingRecipe(false);
    };

    /**
     * Puts what was just saved on the shelf.
     *
     * Saving somebody else's recipe forks it server-side and comes back with a
     * different id, which is the whole point of the copy the user agreed to —
     * so the copy takes the original's place here. Their recipe is untouched
     * and still theirs; this cookbook now holds the version being edited.
     */
    const handleRecipeSaved = async (_meal: Meal | null, _items: Item[], savedRecipe: Recipe) => {
        const previousId = recipeToEdit?.id;
        closeRecipeEditor();
        try {
            if (previousId && previousId !== savedRecipe.id) {
                await removeRecipe(previousId);
                await addRecipe(savedRecipe.id);
            } else if (!previousId) {
                await addRecipe(savedRecipe.id);
            }
        } catch (error) {
            console.error('Failed to update the cookbook after saving a recipe', error);
            Alert.alert('Saved, but not filed', "The recipe was saved but couldn't be added to your cookbook. Pull to refresh and try again.");
        }
        fetchProfileData();
    };

    const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
        const isEnd = contentOffset.x + layoutMeasurement.width >= contentSize.width - 10;
        setIsAtStart(contentOffset.x < 10);
        setIsAtEnd(isEnd);
    };
    const scrollTo = (direction: 'left' | 'right') => {
        const index = direction === 'left' ? 0 : carouselData.length - 1;
        flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
    };

    const handleAddToMealPlan = (recipe: Recipe) => {
            setSelectedRecipe(recipe);
            setIsMealPlanModalVisible(true);
    };

    const handleViewRecipe = (recipeId: string) => {
        setRecipeToViewId(recipeId);
    };

    const handlePhotoSave = async () => {
        if (!newPhotoUri) return;
        try {
            const url = await uploadUserPhoto(newPhotoUri);
            await updateProfile(auth.currentUser!, { photoURL: url });
            refreshAuthUser();
        } catch (err) {
            Alert.alert("Error", "Could not update profile picture.");
        } finally {
            setEditPhotoModalVisible(false);
        }
    };

    // No permission asked for — see complete-profile.tsx. The system picker
    // needs none, and asking is how a request goes astray.
    const handlePickImage = async () => {
        let result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.5,
        });
        if (!result.canceled) setNewPhotoUri(result.assets[0].uri);
    };
    
    const openPhotoModal = () => {
        setNewPhotoUri(authUser?.photoURL || null);
        setEditPhotoModalVisible(true);
    };
    
    if (isDataLoading && cookbook.length == 0) {
        return <View style={styles.centered}><ActivityIndicator size="large" /></View>;
    }
    
    if (authUser?.isAnonymous) {
        return (
            <AmbientBackground>
            <SafeAreaView style={styles.container}>
                {isFocused && <StatusBar style="dark" />}
                <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.ctaContainer}>
                    <Animated.View entering={FadeInDown.duration(600).reduceMotion(ReduceMotion.System)} style={styles.guestContent}>
                        <Text style={styles.eyebrow}>MAKE YOURSELF AT HOME</Text>
                        <Text style={styles.pageTitle}>Your kitchen</Text>
                        <View style={styles.guestIllustration}>
                            <View style={styles.illustrationHalo} />
                            <GlassSurface style={styles.illustrationCard} intensity={60}>
                                <Text style={styles.avocado}>🥑</Text>
                                <View style={styles.illustrationLine} />
                                <View style={[styles.illustrationLine, { width: 42, opacity: 0.4 }]} />
                            </GlassSurface>
                            <GlassSurface style={styles.illustrationBadge}><Ionicons name="heart" size={17} color="#D88871" /><Text style={styles.illustrationBadgeText}>Your favourites, together</Text></GlassSurface>
                            <View style={styles.sparkle}><Ionicons name="sparkles" size={27} color="#B9A56E" /></View>
                        </View>
                        <Text style={styles.ctaTitle}>Good taste.{ '\n' }A place to call home.</Text>
                        <Text style={styles.ctaSubtitle}>Keep the recipes you love and make everyday meals a little more together.</Text>
                        <GlassSurface style={styles.benefitsContainer}>
                            <View style={styles.ctaBenefit}><View style={styles.benefitIcon}><Ionicons name="book-outline" size={22} color={primary} /></View><View style={styles.benefitCopy}><Text style={styles.benefitTitle}>Your personal cookbook</Text><Text style={styles.ctaBenefitText}>All your favourites, in one happy place.</Text></View></View>
                            <View style={styles.benefitDivider} />
                            <View style={styles.ctaBenefit}><View style={[styles.benefitIcon, { backgroundColor: '#F5E9DE' }]}><Ionicons name="people-outline" size={22} color="#A67758" /></View><View style={styles.benefitCopy}><Text style={styles.benefitTitle}>Better with your people</Text><Text style={styles.ctaBenefitText}>Share the shopping. Plan something good.</Text></View></View>
                        </GlassSurface>
                        <TouchableOpacity style={[styles.primaryButton, styles.guestButton]} onPress={() => router.push('/login')}>
                            <Text style={styles.primaryButtonText}>Make yourself at home</Text><Ionicons name="arrow-forward" size={19} color="#FFFFFF" />
                        </TouchableOpacity>
                        <Text style={styles.guestFootnote}>Sign up or log in to your Fridgie account</Text>
                    </Animated.View>
                </ScrollView>
            </SafeAreaView>
            </AmbientBackground>
        );
    }

    if(!authUser) return <></>;

    return (
        <AmbientBackground>
            {isFocused && <StatusBar style="dark" />}
            <SafeAreaView style={styles.container}>

                <SectionList
                    keyboardShouldPersistTaps="handled"
                    sections={[{
                        title: 'My Cookbook',
                        data: filter.rows,
                    }]}
                    keyExtractor={(row) => row.key}
                    stickySectionHeadersEnabled={true}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 126 }}
                    ListHeaderComponent={
                        <ProfileHeader
                            authUser={authUser}
                            cookbook={cookbook}
                            openPhotoModal={openPhotoModal}
                            openNotifications={openNotifications}
                            setSettingsModalVisible={setSettingsModalVisible}
                            followingCount={profileData?.followingCount || 0}
                            followerCount={profileData?.followerCount || 0}
                        />
                    }
                    refreshControl={
                        <RefreshControl refreshing={isRefreshing} onRefresh={() => loadData(true)} tintColor={primary}/>
                    }
                    renderSectionHeader={() => (
                        <View style={styles.stickyHeaderContainer}>
                            <View style={styles.cookbookTitleRow}><Text style={styles.cookbookTitle}>Your cookbook</Text><Text style={styles.recipeCount}>{cookbook.length} recipes</Text></View>
                            <View style={styles.searchRow}>
                                <View style={styles.searchContainer}>
                                    <Ionicons name="search" size={20} color="#999" style={styles.searchIcon} />
                                    <TextInput
                                        style={styles.searchInput}
                                        placeholder="Find something delicious"
                                        value={filter.searchTerm}
                                        onChangeText={filter.setSearchTerm}
                                        placeholderTextColor={'#999'}
                                    />
                                </View>
                                {/* Next to the search box because that is where you
                                    already are when the recipe you wanted isn't
                                    there. Straight to the shelf — no week, no day,
                                    nothing added to a shopping list. */}
                                <TouchableOpacity
                                    style={styles.addRecipeButton}
                                    onPress={handleAddRecipe}
                                    accessibilityRole="button"
                                    accessibilityLabel="Add a recipe to your cookbook"
                                >
                                    <Ionicons name="add" size={26} color="#fff" />
                                </TouchableOpacity>
                            </View>
                            {/* Sticky along with the search box: the shelf you
                                picked has to stay visible while you scroll it,
                                or a short category reads as an empty cookbook. */}
                            <CookbookFilterBar
                                chips={filter.chips}
                                selected={filter.category}
                                onSelect={filter.setCategory}
                                sort={filter.sort}
                                onSortChange={filter.setSort}
                            />
                        </View>
                    )}
                    renderItem={({ item }) => (
                        item.type === 'header' ? (
                            <CookbookGroupHeader category={item.category} count={item.count} />
                        ) : (
                            <RecipeCard
                                recipe={item.recipe}
                                onAddToMealPlan={handleAddToMealPlan}
                                onView={handleViewRecipe}
                            />
                        )
                    )}
                    ListEmptyComponent={
                        <View style={styles.feedPlaceholder}>
                           <View style={styles.emptyIcon}><Ionicons name="book-outline" size={30} color={primary} /></View>
                           <Text style={styles.feedPlaceholderText}>
                            {filter.isFiltered ? 'Nothing here just yet' : 'Every cookbook starts somewhere'}
                           </Text>
                           <Text style={styles.feedPlaceholderSubtitle}>{filter.isFiltered ? 'Try another search or category.' : 'Add a recipe you love. Make it yours.'}</Text>
                           {!filter.isFiltered && <TouchableOpacity style={styles.emptyAction} onPress={handleAddRecipe}><Ionicons name="add" size={17} color={primary} /><Text style={styles.emptyActionText}>Add your first recipe</Text></TouchableOpacity>}
                       </View>
                    }
                />

                <Modal visible={editPhotoModalVisible} animationType={reduceMotion ? "none" : "slide"} transparent={true}>
                    <View style={styles.modalContainer}>
                        <View style={styles.modalContent}>
                            <Text style={styles.modalTitle}>Update Profile Photo</Text>
                            {newPhotoUri && <Image source={{ uri: newPhotoUri }} style={styles.modalMainAvatar} />}
                            <View style={styles.carouselContainer}>
                                <TouchableOpacity style={[styles.arrowButton, isAtStart && styles.transparentButton]} onPress={() => scrollTo('left')}><Ionicons name="chevron-back" size={24} color="#666" /></TouchableOpacity>
                                <FlatList
                                    ref={flatListRef}
                                    data={carouselData}
                                    horizontal
                                    showsHorizontalScrollIndicator={false}
                                    keyExtractor={(item) => item}
                                    onScroll={handleScroll}
                                    scrollEventThrottle={16}
                                    contentContainerStyle={styles.flatListContent}
                                    renderItem={({ item }) => {
                                        if (item === 'upload') {
                                            return <TouchableOpacity style={styles.uploadButton} onPress={handlePickImage}><Ionicons name="camera-outline" size={24} color="#666" /></TouchableOpacity>;
                                        }
                                        return <TouchableOpacity onPress={() => setNewPhotoUri(item)}><Image source={{ uri: item }} style={[styles.gridAvatar, newPhotoUri === item && styles.selectedAvatar]} /></TouchableOpacity>;
                                    }}
                                />
                                <TouchableOpacity style={[styles.arrowButton, isAtEnd && styles.transparentButton]} onPress={() => scrollTo('right')}><Ionicons name="chevron-forward" size={24} color="#666" /></TouchableOpacity>
                            </View>
                            <View style={styles.modalButtons}>
                                <TouchableOpacity style={[styles.modalButton, styles.secondaryButton]} onPress={() => setEditPhotoModalVisible(false)}><Text style={styles.secondaryButtonText}>Cancel</Text></TouchableOpacity>
                                <TouchableOpacity style={[styles.modalButton, styles.primaryButton]} onPress={handlePhotoSave}><Text style={styles.primaryButtonText}>Save</Text></TouchableOpacity>
                            </View>
                        </View>
                    </View>
                </Modal>
                <SettingsModal
                    isVisible={settingsModalVisible}
                    onClose={() => setSettingsModalVisible(false)}
                    onNavigate={handleSettingsNavigate}
                    onDismiss={flushPendingSettingsRoute}
                />
                <NotificationsModal
                    isVisible={isNotificationsVisible}
                    onClose={() => setNotificationsVisible(false)}
                    notifications={notifications}
                    isLoading={isNotificationsLoading}
                    onAccept={handleAccept}
                    onDecline={handleDecline}
                />
                <AddToMealPlanModal
                    isVisible={isMealPlanModalVisible}
                    onClose={() => setIsMealPlanModalVisible(false)}
                    recipe={selectedRecipe}
                />
                
                <ViewRecipeModal
                    isVisible={!!recipeToViewId}
                    onClose={() => setRecipeToViewId(null)}
                    recipeId={recipeToViewId}
                    onEdit={handleEditRecipe}
                    onCookbookUpdate={fetchProfileData}
                />
                
                <AddEditRecipeModal
                    isVisible={!!recipeToEdit || isAddingRecipe}
                    onClose={closeRecipeEditor}
                    mealForRecipe={null}
                    recipeToEdit={recipeToEdit}
                    onRecipeSave={handleRecipeSaved}
                />
            </SafeAreaView>
        </AmbientBackground>
    );
}

const styles = StyleSheet.create({
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F5F5EF' },
    container: { flex: 1, backgroundColor: 'transparent', paddingTop: Platform.OS === 'android' ? SB.currentHeight : 0 },
    pageHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 19, paddingBottom: 26 },
    eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.6, color: '#78857D', marginBottom: 8 },
    pageTitle: { fontSize: 34, lineHeight: 40, fontWeight: '700', letterSpacing: -1.4, color: '#173F35' },
    headerButtons: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    settingsGlass: { borderRadius: 22 },
    settingsButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    profileContainer: { alignItems: 'center', paddingTop: 26, paddingBottom: 8, borderRadius: 30, overflow: 'hidden' },
    profileAccent: { position: 'absolute', width: 280, height: 280, borderRadius: 140, backgroundColor: 'rgba(220,237,226,0.6)', top: -185, right: -90 },
    profileImageContainer: { marginBottom: 14 },
    profileImage: { width: 96, height: 96, borderRadius: 38, borderWidth: 3, borderColor: '#fff' },
    placeholderImage: { backgroundColor: '#DCEDE2', justifyContent: 'center', alignItems: 'center' },
    editIconContainer: { position: 'absolute', bottom: -2, right: -3, backgroundColor: primary, borderRadius: 15, padding: 7, borderWidth: 2, borderColor: '#fff' },
    displayName: { fontSize: 28, fontWeight: '700', letterSpacing: -0.8, color: '#173F35', marginBottom: 4 },
    usernameText: { fontSize: 14, color: '#78857D', marginBottom: 14 },
    statsContainer: { flexDirection: 'row', width: '100%', paddingVertical: 18, marginTop: 4 },
    statItem: { flex: 1, alignItems: 'center' },
    statDivider: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: '#E1E8DC' },
    statNumber: { fontSize: 23, fontWeight: '700', letterSpacing: -0.6, color: '#173F35' },
    statLabel: { fontSize: 11, color: '#78857D', marginTop: 5, fontWeight: '500' },
    stickyHeaderContainer: { backgroundColor: '#F5F5EF', paddingTop: 26 },
    cookbookTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
    cookbookTitle: { fontSize: 25, fontWeight: '700', letterSpacing: -0.8, color: '#173F35' },
    recipeCount: { fontSize: 12, color: '#78857D' },
    searchRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 14 },
    searchContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: 18, paddingHorizontal: 15, borderWidth: 1, borderColor: '#E6EBE1' },
    addRecipeButton: { width: 50, height: 50, borderRadius: 18, backgroundColor: primary, alignItems: 'center', justifyContent: 'center' },
    searchIcon: { marginRight: 8 },
    searchInput: { flex: 1, height: 48, fontSize: 14, color: '#173F35' },
    feedPlaceholder: { alignItems: 'center', justifyContent: 'center', paddingVertical: 38, paddingHorizontal: 12 },
    emptyIcon: { width: 70, height: 70, borderRadius: 25, backgroundColor: '#E1ECE2', alignItems: 'center', justifyContent: 'center' },
    feedPlaceholderText: { marginTop: 18, fontSize: 19, fontWeight: '600', letterSpacing: -0.4, color: '#173F35', textAlign: 'center' },
    feedPlaceholderSubtitle: { marginTop: 8, fontSize: 14, color: '#78857D', textAlign: 'center', lineHeight: 21 },
    emptyAction: { flexDirection: 'row', gap: 6, padding: 14, marginTop: 8, alignItems: 'center' },
    emptyActionText: { color: primary, fontWeight: '600', fontSize: 14 },
    modalContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(23,63,53,0.24)' },
    modalContent: { backgroundColor: '#F5F5EF', padding: 25, borderRadius: 30, width: '90%', maxWidth: 460, alignItems: 'center' },
    modalTitle: { fontSize: 23, fontWeight: '700', letterSpacing: -0.6, color: '#173F35', marginBottom: 24, alignSelf: 'center' },
    modalMainAvatar: { width: 104, height: 104, borderRadius: 38, backgroundColor: '#DCEDE2', marginBottom: 20 },
    modalButtons: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', marginTop: 24 },
    modalButton: { flex: 1, marginHorizontal: 5, paddingVertical: 15, borderRadius: 19, alignItems: 'center' },
    carouselContainer: { flexDirection: 'row', alignItems: 'center', width: '100%' },
    arrowButton: { paddingHorizontal: 4, minHeight: 44, justifyContent: 'center' },
    transparentButton: { opacity: 0 },
    flatListContent: { paddingHorizontal: 8 },
    gridAvatar: { width: 60, height: 60, borderRadius: 24, margin: 5, backgroundColor: '#E1ECE2' },
    selectedAvatar: { borderWidth: 3, borderColor: primary },
    uploadButton: { width: 60, height: 60, borderRadius: 24, margin: 5, backgroundColor: '#E6EBE4', justifyContent: 'center', alignItems: 'center' },
    modalViewContainer: { flex: 1, backgroundColor: '#F5F5EF' },
    modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingTop: 24, paddingBottom: 14 },
    modalHeaderTitle: { fontSize: 30, fontWeight: '700', letterSpacing: -1, color: '#173F35' },
    closeButton: { padding: 5 },
    modalScrollView: { paddingHorizontal: 24 },
    sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', marginTop: 30, marginBottom: 14, color: '#78857D' },
    editMealPreferences: { flexDirection: 'row', alignItems: 'center', borderRadius: 20, padding: 20, backgroundColor: '#FFFFFF' },
    manageGroups: { flexDirection: 'row', alignItems: 'center', borderRadius: 20, marginBottom: 10, padding: 20, backgroundColor: '#FFFFFF' },
    editMealPreferencesText: { color: '#173F35', fontSize: 15, fontWeight: '600', marginLeft: 12 },
    infoRow: { padding: 18, backgroundColor: '#FFFFFF', borderRadius: 20, marginBottom: 10 },
    infoLabel: { fontSize: 12, color: '#78857D', marginBottom: 7 },
    viewContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    infoInput: { flex: 1, fontSize: 15, borderWidth: 1, borderColor: '#E2E8DE', borderRadius: 13, padding: 10, marginRight: 4, color: '#173F35' },
    editContainer: { flexDirection: 'row', alignItems: 'center' },
    inlineButton: { paddingHorizontal: 12, paddingVertical: 10, backgroundColor: primary, borderRadius: 14, marginLeft: 4 },
    inlineButtonText: { color: '#fff', fontWeight: '600' },
    inlineButtonSecondary: { paddingHorizontal: 8, paddingVertical: 10 },
    inlineButtonSecondaryText: { color: '#78857D', fontWeight: '500', fontSize: 12 },
    infoValue: { marginRight: 8, color: '#173F35', flexShrink: 1 },
    editPencilButton: { width: 30, height: 30, borderRadius: 12, backgroundColor: primary, justifyContent: 'center', alignItems: 'center' },
    primaryButton: { backgroundColor: primary, paddingVertical: 16, paddingHorizontal: 25, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
    primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
    secondaryButton: { backgroundColor: '#E6EBE4' },
    secondaryButtonText: { color: '#476458', fontSize: 16, fontWeight: '600' },
    ctaContainer: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 23, paddingBottom: 126 },
    guestContent: { width: '100%', maxWidth: 520, alignSelf: 'center' },
    guestIllustration: { height: 208, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
    illustrationHalo: { width: 190, height: 190, borderRadius: 95, backgroundColor: 'rgba(220,237,226,0.75)', position: 'absolute' },
    illustrationCard: { width: 128, height: 144, borderRadius: 29, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-9deg' }] },
    avocado: { fontSize: 59, marginBottom: 9 },
    illustrationLine: { height: 5, width: 64, backgroundColor: '#AAC0A6', borderRadius: 4, marginTop: 5 },
    illustrationBadge: { position: 'absolute', bottom: 20, right: 0, flexDirection: 'row', gap: 7, alignItems: 'center', paddingVertical: 12, paddingHorizontal: 13, borderRadius: 22 },
    illustrationBadgeText: { fontSize: 11, fontWeight: '600', color: '#476458' },
    sparkle: { position: 'absolute', top: 33, right: 64 },
    ctaTitle: { fontSize: 33, lineHeight: 37, fontWeight: '700', letterSpacing: -1.2, textAlign: 'center', marginBottom: 12, color: '#173F35' },
    ctaSubtitle: { fontSize: 14, color: '#78857D', textAlign: 'center', marginBottom: 24, lineHeight: 22, paddingHorizontal: 14 },
    benefitsContainer: { alignSelf: 'stretch', borderRadius: 26, paddingHorizontal: 16, paddingVertical: 5 },
    ctaBenefit: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
    benefitIcon: { width: 43, height: 43, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E4EEE3' },
    benefitCopy: { flex: 1, marginLeft: 13 },
    benefitTitle: { fontSize: 14, fontWeight: '600', color: '#173F35', marginBottom: 4 },
    ctaBenefitText: { fontSize: 11, lineHeight: 17, color: '#78857D' },
    benefitDivider: { height: 1, backgroundColor: '#E4E9DF', marginLeft: 56 },
    guestButton: { marginTop: 23, flexDirection: 'row', gap: 13, minHeight: 56, shadowColor: '#173F35', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: 7 } },
    guestFootnote: { fontSize: 11, color: '#78857D', marginTop: 13, textAlign: 'center' },
});
