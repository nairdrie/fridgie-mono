import NotificationBell from '@/components/NotificationBell';
import NotificationsModal from '@/components/NotificationsModal';
import RecipeCard from '@/components/RecipeCard';
import { useAuth } from '@/context/AuthContext';
import { useNotifications } from '@/context/NotificationContext';
import { Recipe } from '@/types/types';
import { getUserCookbook, uploadUserPhoto } from '@/utils/api';
import { defaultAvatars } from '@/utils/defaultAvatars';
import { auth } from '@/utils/firebase';
import { primary } from '@/utils/styles';
import { toReadablePhone } from '@/utils/utils';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { updateEmail, updateProfile, User } from 'firebase/auth';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Image,
    Modal,
    NativeScrollEvent,
    NativeSyntheticEvent,
    RefreshControl,
    SafeAreaView,
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

const SettingsModal = ({ isVisible, onClose }: { isVisible: boolean; onClose: () => void }) => {
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
        <Modal visible={isVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
            <SafeAreaView style={styles.modalViewContainer}>
                <View style={styles.modalHeader}>
                    <Text style={styles.modalHeaderTitle}>Settings</Text>
                    <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                        <Ionicons name="close-circle-outline" size={30} color={primary} />
                    </TouchableOpacity>
                </View>
                <ScrollView style={styles.modalScrollView}>
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
                    <TouchableOpacity style={styles.manageGroups} onPress={() => router.push('/groups')}>
                        <Ionicons name="people" size={16} color={primary}></Ionicons>
                        <Text style={styles.editMealPreferencesText}>Manage Groups</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.editMealPreferences} onPress={() => router.push('/meal-preferences')}>
                        <Ionicons name="open-outline" size={16} color={primary}></Ionicons>
                        <Text style={styles.editMealPreferencesText}>Edit Meal Preferences</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.primaryButton, { marginTop: 30, width: '100%' }]} onPress={() => {
                        auth.signOut();
                        router.navigate('/list');
                        onClose();
                    }}>
                        <Text style={styles.primaryButtonText}>Sign Out</Text>
                    </TouchableOpacity>
                </ScrollView>
            </SafeAreaView>
        </Modal>
    );
};

const ProfileHeader = ({ authUser, cookbook, openPhotoModal }: {authUser: User, cookbook: Recipe[], openPhotoModal: any}) => (
    <>
        <View style={styles.profileContainer}>
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
            <View style={styles.statItem}><Text style={styles.statNumber}>0</Text><Text style={styles.statLabel}>Following</Text></View>
            <View style={styles.statItem}><Text style={styles.statNumber}>0</Text><Text style={styles.statLabel}>Followers</Text></View>
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

    const flatListRef = useRef<FlatList | null>(null);
    const [isAtStart, setIsAtStart] = useState(true);
    const [isAtEnd, setIsAtEnd] = useState(false);
    const carouselData = [...defaultAvatars, 'upload'];
    
    const [searchTerm, setSearchTerm] = useState('');
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [cookbook, setCookbook] = useState<Recipe[]>([]);
    const [isCookbookLoading, setIsCookbookLoading] = useState(true);
    
    const [isFocused, setIsFocused] = useState(false);
    useFocusEffect(
        useCallback(() => {
            setIsFocused(true);
            return () => setIsFocused(false);
        }, [])
    );

    const fetchCookbook = useCallback(async () => {
        if (!authUser || authUser.isAnonymous) {
            setIsCookbookLoading(false);
            return;
        };
        setIsRefreshing(true);
        try {
            const userCookbook = await getUserCookbook(authUser.uid);
            setCookbook(userCookbook);
        } catch (error) {
            console.error("Failed to fetch cookbook:", error);
        } finally {
            setIsCookbookLoading(false);
            setIsRefreshing(false);
        }
    }, [authUser]);

    useEffect(() => {
        fetchCookbook();
    }, [authUser, fetchCookbook]);

    const filteredRecipes = useMemo(() => {
        if (!searchTerm) return cookbook;
        return cookbook.filter(recipe =>
            recipe.name.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }, [cookbook, searchTerm]);

    const handleAccept = (invitationId: string) => { /* ... same as before ... */ };
    const handleDecline = (invitationId: string) => { /* ... same as before ... */ };

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

    const handlePickImage = async () => {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
            Alert.alert('Sorry, we need camera roll permissions!');
            return;
        }
        let result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
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
    
    if (isCookbookLoading && cookbook.length === 0) {
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
                <View style={styles.headerButtons}>
                    <NotificationBell onPress={() => setNotificationsVisible(true)} />
                    <TouchableOpacity onPress={() => setSettingsModalVisible(true)} style={styles.settingsButton}>
                        <Ionicons name="settings-outline" size={28} color="#000" />
                    </TouchableOpacity>
                </View>

                <SectionList
                    sections={[{
                        title: 'My Cookbook',
                        data: filteredRecipes,
                    }]}
                    keyExtractor={(item) => item.id}
                    stickySectionHeadersEnabled={true}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{ paddingHorizontal: 16 }}
                    ListHeaderComponent={
                        <ProfileHeader
                            authUser={authUser}
                            cookbook={cookbook}
                            openPhotoModal={openPhotoModal}
                        />
                    }
                    refreshControl={
                        <RefreshControl refreshing={isRefreshing} onRefresh={fetchCookbook} tintColor={primary}/>
                    }
                    renderSectionHeader={() => (
                        <View style={styles.stickyHeaderContainer}>
                            <View style={styles.searchContainer}>
                                <Ionicons name="search" size={20} color="#999" style={styles.searchIcon} />
                                <TextInput
                                    style={styles.searchInput}
                                    placeholder="Search your cookbook..."
                                    value={searchTerm}
                                    onChangeText={setSearchTerm}
                                />
                            </View>
                        </View>
                    )}
                    renderItem={({ item }) => (
                        <RecipeCard
                            recipe={item}
                            onAddToMealPlan={() => {}} // Add your handlers here
                            onView={() => {}}          // Add your handlers here
                        />
                    )}
                    ListEmptyComponent={
                        <View style={styles.feedPlaceholder}>
                           <Ionicons name="receipt-outline" size={48} color="#ccc" />
                           <Text style={styles.feedPlaceholderText}>
                            {searchTerm ? `No recipes found for "${searchTerm}"` : "Your cookbook is empty."}
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
                <SettingsModal isVisible={settingsModalVisible} onClose={() => setSettingsModalVisible(false)} />
                <NotificationsModal
                    isVisible={isNotificationsVisible}
                    onClose={() => setNotificationsVisible(false)}
                    notifications={notifications}
                    isLoading={isNotificationsLoading}
                    onAccept={handleAccept}
                    onDecline={handleDecline}
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
    },
    headerButtons: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        paddingHorizontal: 10,
        alignItems: 'center',
        position: 'absolute',
        top: Constants.statusBarHeight + 10,
        right: 10,
        zIndex: 10,
    },
    settingsButton: {
        padding: 5,
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
    searchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#fff',
        borderRadius: 10,
        paddingHorizontal: 12,
        marginBottom: 16,
        borderWidth: 1,
        borderColor: '#e9ecef'
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