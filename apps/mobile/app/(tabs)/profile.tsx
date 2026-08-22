import AddEditRecipeModal from '@/components/AddEditRecipeModal';
import AddToMealPlanModal from '@/components/AddToMealPlanModal';
import CookbookFilterBar, { CookbookGroupHeader } from '@/components/CookbookFilterBar';
import NotificationBell from '@/components/NotificationBell';
import NotificationsModal from '@/components/NotificationsModal';
import RecipeCard from '@/components/RecipeCard';
import ViewRecipeModal from '@/components/ViewRecipeModal';
import { useAuth } from '@/context/AuthContext';
import { useNotifications } from '@/context/NotificationContext';
import { useCookbookFilter } from '@/hooks/useCookbookFilter';
import { Item, Meal, Recipe } from '@/types/types';
import { addUserCookbookRecipe, getUserCookbook, getUserProfile, removeUserCookbookRecipe, uploadUserPhoto } from '@/utils/api';
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
    TouchableOpacity,
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
    const router = useRouter();
    const { user, refreshAuthUser } = useAuth();

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
        <Modal visible={isVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose} onDismiss={onDismiss}>
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
                <ScrollView style={styles.modalScrollView} keyboardShouldPersistTaps="handled">
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
    setNotificationsVisible, 
    setSettingsModalVisible,
    followerCount,
    followingCount
 }: {
    authUser: User, 
    cookbook: Recipe[], 
    openPhotoModal: any, 
    setNotificationsVisible: any, 
    setSettingsModalVisible: any,
    followerCount: number,
    followingCount: number,
}) => (
    <>
        <View style={styles.profileContainer}>
            <View style={styles.headerButtons}>
                <NotificationBell onPress={() => setNotificationsVisible(true)} />
                <TouchableOpacity onPress={() => setSettingsModalVisible(true)} style={styles.settingsButton}>
                    <Ionicons name="settings-outline" size={28} color="#000" />
                </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={openPhotoModal} style={styles.profileImageContainer}>
                {authUser?.photoURL ? (
                    <Image source={{ uri: authUser.photoURL }} style={styles.profileImage} />
                ) : (
                    <View style={[styles.profileImage, styles.placeholderImage]}>
                        <Ionicons name="person" size={60} color="#ccc" />
                    </View>
                )}
                <View style={styles.editIconContainer}>
                    <Ionicons name="pencil" size={16} color="#fff" />
                </View>
            </TouchableOpacity>
            <Text style={styles.displayName}>{authUser?.displayName || 'Fridgie User'}</Text>
            {authUser?.email && <Text style={styles.usernameText}>@{authUser.email.split('@')[0]}</Text>}
        </View>
        <View style={styles.statsContainer}>
            <View style={styles.statItem}><Text style={styles.statNumber}>{followingCount || 0}</Text><Text style={styles.statLabel}>Following</Text></View>
            <View style={styles.statItem}><Text style={styles.statNumber}>{followerCount || 0}</Text><Text style={styles.statLabel}>Followers</Text></View>
            <View style={styles.statItem}><Text style={styles.statNumber}>{cookbook.length || 0}</Text><Text style={styles.statLabel}>Recipes</Text></View>
        </View>
    </>
);


// --- Main Profile Component ---

export default function UserProfile() {
    const { user: authUser, refreshAuthUser } = useAuth();
    const router = useRouter();

    const [editPhotoModalVisible, setEditPhotoModalVisible] = useState(false);
    const [settingsModalVisible, setSettingsModalVisible] = useState(false);
    const [newPhotoUri, setNewPhotoUri] = useState<string | null>(null);
    const { notifications, isLoading: isNotificationsLoading, acceptInvitation, declineInvitation } = useNotifications();
    const [isNotificationsVisible, setNotificationsVisible] = useState(false);

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
                await removeUserCookbookRecipe(previousId);
                await addUserCookbookRecipe(savedRecipe.id);
            } else if (!previousId) {
                await addUserCookbookRecipe(savedRecipe.id);
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
            <SafeAreaView style={styles.container}>
                <View style={styles.ctaContainer}>
                    <Ionicons name="person-add-outline" size={60} color={primary} style={styles.ctaIcon} />
                    <Text style={styles.ctaTitle}>Create an Account</Text>
                    <Text style={styles.ctaSubtitle}>Ready for the full experience? Sign up or log in to:</Text>
                    <View style={styles.benefitsContainer}>
                        <View style={styles.ctaBenefit}><Ionicons name="bookmark-outline" size={24} color={primary} /><Text style={styles.ctaBenefitText}>Save recipes to your personal cookbook</Text></View>
                        <View style={styles.ctaBenefit}><Ionicons name="people-outline" size={24} color={primary} /><Text style={styles.ctaBenefitText}>Collaborate on shopping lists and meal plans</Text></View>
                    </View>
                    <TouchableOpacity style={styles.primaryButton} onPress={() => router.push('/login')}>
                        <Text style={styles.primaryButtonText}>Sign Up or Log In</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    if(!authUser) return <></>;

    return (
        <>
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
                    contentContainerStyle={{ paddingHorizontal: 16 }}
                    ListHeaderComponent={
                        <ProfileHeader
                            authUser={authUser}
                            cookbook={cookbook}
                            openPhotoModal={openPhotoModal}
                            setNotificationsVisible={setNotificationsVisible}
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
                            <View style={styles.searchRow}>
                                <View style={styles.searchContainer}>
                                    <Ionicons name="search" size={20} color="#999" style={styles.searchIcon} />
                                    <TextInput
                                        style={styles.searchInput}
                                        placeholder="Search your cookbook..."
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
                           <Ionicons name="receipt-outline" size={48} color="#ccc" />
                           <Text style={styles.feedPlaceholderText}>
                            {filter.isFiltered ? 'No recipes match that.' : 'Your cookbook is empty.'}
                           </Text>
                       </View>
                    }
                />

                <Modal visible={editPhotoModalVisible} animationType="slide" transparent={true}>
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
                    isInCookbook={cookbook.some(r => r.id === recipeToViewId)}
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
        </>
    );
}

const styles = StyleSheet.create({
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    container: {
        flex: 1,
        backgroundColor: '#f8f9fa',
        paddingTop: Platform.OS === 'android' ? SB.currentHeight : 0,
    },
    headerButtons: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        position: 'absolute',
        top:0,
        right: 0,
        zIndex: 10,
    },
    settingsButton: {
        paddingLeft: 15,
        paddingRight: 9
    },
    profileContainer: {
        alignItems: 'center',
        paddingVertical: 24,
        paddingTop: 60, // Add padding to not be obscured by headerButtons
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
    editIconContainer: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        backgroundColor: primary,
        borderRadius: 15,
        padding: 6,
        borderWidth: 2,
        borderColor: '#fff',
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
    stickyHeaderContainer: {
        backgroundColor: '#f8f9fa',
        paddingTop: 16,
    },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        marginBottom: 12,
    },
    searchContainer: {
        // The search box gives up whatever width the + needs; without this it
        // holds its content width and pushes the button off the row.
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#fff',
        borderRadius: 10,
        paddingHorizontal: 12,
        borderWidth: 1,
        borderColor: '#e9ecef'
    },
    // Square-ish and the same height as the search box beside it, so the row
    // reads as one control rather than a field with a sticker on the end.
    addRecipeButton: {
        width: 46,
        height: 46,
        borderRadius: 10,
        backgroundColor: primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    searchIcon: { marginRight: 8 },
    searchInput: { flex: 1, height: 44, fontSize: 16 },
    feedPlaceholder: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 40,
        marginTop: 20
    },
    feedPlaceholderText: {
        marginTop: 16,
        fontSize: 16,
        color: '#6c757d',
        textAlign: 'center',
    },
    // Styles for Modals
    modalContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' },
    modalContent: { backgroundColor: 'white', padding: 20, borderRadius: 10, width: '90%', alignItems: 'center' },
    modalTitle: { fontSize: 24, fontWeight: 'bold', marginBottom: 20, alignSelf: 'center' },
    modalMainAvatar: { width: 100, height: 100, borderRadius: 50, backgroundColor: '#eee', marginBottom: 16 },
    modalButtons: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', marginTop: 20 },
    modalButton: { flex: 1, marginHorizontal: 8, paddingVertical: 12, borderRadius: 25, alignItems: 'center' },
    carouselContainer: { flexDirection: 'row', alignItems: 'center', width: '100%' },
    arrowButton: { paddingHorizontal: 4 },
    transparentButton: { opacity: 0 },
    flatListContent: { paddingHorizontal: 10 },
    gridAvatar: { width: 60, height: 60, borderRadius: 30, margin: 5, backgroundColor: '#eee' },
    selectedAvatar: { borderWidth: 3, borderColor: primary },
    uploadButton: { width: 60, height: 60, borderRadius: 30, margin: 5, backgroundColor: '#f0f0f0', justifyContent: 'center', alignItems: 'center' },
    modalViewContainer: { flex: 1, backgroundColor: '#f8f9fa' },
    modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#eee', backgroundColor: '#fff' },
    modalHeaderTitle: { fontSize: 20, fontWeight: 'bold', color: '#333' },
    closeButton: { padding: 5 },
    modalScrollView: { paddingHorizontal: 16 },
    sectionTitle: { fontSize: 22, fontWeight: 'bold', marginVertical: 16, color: '#333' },
    editMealPreferences: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', borderRadius: 8 },
    manageGroups: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', borderRadius: 8, marginBottom: 16 },
    editMealPreferencesText: { color: primary, fontSize: 16, fontWeight: '500', marginLeft: 8 },
    infoRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
    infoLabel: { fontSize: 14, color: '#666', marginBottom: 4 },
    viewContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    infoInput: { flex: 1, fontSize: 16, borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8, marginRight: 8 },
    editContainer: { flexDirection: 'row', alignItems: 'center' },
    inlineButton: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: primary, borderRadius: 15, marginLeft: 8 },
    inlineButtonText: { color: '#fff', fontWeight: '500' },
    inlineButtonSecondary: { paddingHorizontal: 12, paddingVertical: 6 },
    inlineButtonSecondaryText: { color: '#666', fontWeight: '500' },
    infoValue: { marginRight: 8 },
    editPencilButton: { width: 28, height: 28, borderRadius: 14, backgroundColor: primary, justifyContent: 'center', alignItems: 'center' },
    primaryButton: { backgroundColor: primary, paddingVertical: 12, paddingHorizontal: 30, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
    primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
    secondaryButton: { backgroundColor: '#e9ecef' },
    secondaryButtonText: { color: '#495057', fontSize: 16, fontWeight: '600' },
    ctaContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 30, backgroundColor: '#fff' },
    ctaIcon: { marginBottom: 20 },
    ctaTitle: { fontSize: 26, fontWeight: 'bold', textAlign: 'center', marginBottom: 12, color: '#212529' },
    ctaSubtitle: { fontSize: 16, color: '#6c757d', textAlign: 'center', marginBottom: 40, lineHeight: 24 },
    benefitsContainer: { alignSelf: 'stretch' },
    ctaBenefit: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
    ctaBenefitText: { fontSize: 16, marginLeft: 15, color: '#495057', flex: 1 },
});