// screens/UserProfile.tsx

import { useAuth } from '@/context/AuthContext';
import { Group } from '@/types/types';
import { createGroup, searchUsers } from '@/utils/api'; // Import searchUsers
import { defaultAvatars } from '@/utils/defaultAvatars';
import { auth, storage } from '@/utils/firebase';
import { toReadablePhone } from '@/utils/utils';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { updateEmail, updateProfile, User } from 'firebase/auth';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { debounce } from 'lodash'; // A helpful utility for search
import React, { useCallback, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Image,
    Modal,
    NativeScrollEvent,
    NativeSyntheticEvent,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';

// (EditableInfoRow component remains the same)
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

export default function UserProfile() {
    const router = useRouter();
    const { user, groups, selectGroup, refreshAuthUser } = useAuth();
    const [loading, setLoading] = useState(false);
    const [editModalVisible, setEditModalVisible] = useState<'photo' | null>(null);
    const [newPhotoUri, setNewPhotoUri] = useState(user?.photoURL || null);

    // --- Create Group Modal State ---
    const [isGroupModalVisible, setGroupModalVisible] = useState(false);
    const [newGroupName, setNewGroupName] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<User[]>([]);
    const [invitedMembers, setInvitedMembers] = useState<User[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    // --- Carousel State and Logic (remains the same) ---
    const flatListRef = useRef<FlatList | null>(null);
    const [isAtStart, setIsAtStart] = useState(true);
    const [isAtEnd, setIsAtEnd] = useState(false);
    const carouselData = [...defaultAvatars, 'upload'];
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

    // --- Debounced Search Handler ---
    const debouncedSearch = useCallback(
        debounce(async (query:any) => {
            if (query.length < 2) {
                setSearchResults([]);
                setIsSearching(false);
                return;
            }
            try {
                const results = await searchUsers(query);
                // Filter out the current user and already invited members from results
                const currentUserUid = auth.currentUser?.uid;
                const invitedMemberUids = new Set(invitedMembers.map(m => m.uid));
                const filteredResults = results.filter(
                    u => u.uid !== currentUserUid && !invitedMemberUids.has(u.uid)
                );
                setSearchResults(filteredResults);
            } catch (error) {
                console.error("Search failed:", error);
                setSearchResults([]);
            } finally {
                setIsSearching(false);
            }
        }, 300), // 300ms delay
        [invitedMembers] // Recreate debounce function if invitedMembers changes
    );

    const handleSearchChange = (text: string) => {
        setSearchQuery(text);
        setIsSearching(true);
        debouncedSearch(text);
    };
    
    // --- Group Creation Logic ---
    const openCreateGroupModal = () => {
        if (!auth.currentUser || auth.currentUser.isAnonymous) {
            router.push('/login');
            return;
        }
        // Reset state when opening
        setNewGroupName('');
        setSearchQuery('');
        setSearchResults([]);
        setInvitedMembers([]);
        setGroupModalVisible(true);
    };

    const handleInviteUser = (userToInvite: User) => {
        setInvitedMembers(prev => [...prev, userToInvite]);
        setSearchResults(prev => prev.filter(u => u.uid !== userToInvite.uid));
    };

    const handleRemoveUser = (userToRemove: User) => {
        setInvitedMembers(prev => prev.filter(u => u.uid !== userToRemove.uid));
    };

    const submitCreateGroup = async () => {
        if (!newGroupName.trim()) {
            Alert.alert("Validation Error", "Please enter a name for your group.");
            return;
        }
        setLoading(true);
        try {
            const memberUids = invitedMembers.map(m => m.uid);
            if(auth.currentUser?.uid) {
                memberUids.push(auth.currentUser.uid);
            }
            await createGroup(newGroupName, memberUids);
            refreshAuthUser(); // This will refetch groups in your AuthContext
            setGroupModalVisible(false);
        } catch (err) {
            console.error('Failed to create group', err);
            Alert.alert("Error", "Could not create the group. Please try again.");
        } finally {
            setLoading(false);
        }
    };


    // --- Other functions (navigateToList, handlePhotoSave, etc. remain the same) ---
    const navigateToList = (group: Group) => {
        selectGroup(group);
        router.push('/list');
    };
    const handlePhotoSave = async () => {
        if (!newPhotoUri) return;
        setLoading(true);
        try {
            const userToUpdate = auth.currentUser;
            if (!userToUpdate) throw new Error("User not found");
            let finalPhotoURL = newPhotoUri;
            if (newPhotoUri.startsWith('file://')) {
                const response = await fetch(newPhotoUri);
                const blob = await response.blob();
                const storageRef = ref(storage, `profile_images/${userToUpdate.uid}`);
                await uploadBytes(storageRef, blob);
                finalPhotoURL = await getDownloadURL(storageRef);
            }
            await updateProfile(userToUpdate, { photoURL: finalPhotoURL });
            refreshAuthUser();
        } catch (err) {
            Alert.alert("Error", "Could not update profile picture.");
        } finally {
            setLoading(false);
            setEditModalVisible(null);
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
        if (!result.canceled) {
            setNewPhotoUri(result.assets[0].uri);
        }
    };
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
    const handlePhoneSave = async (newPhone: string) => {
        Alert.alert("Feature Coming Soon", "Updating your phone number requires re-verification.");
    };
    const openPhotoModal = () => {
        setNewPhotoUri(user?.photoURL || null);
        setEditModalVisible('photo');
    };

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView>
                {/* Profile Section */}
                <View style={styles.groupsContainer}>
                    <Text style={styles.sectionTitle}>My Profile</Text>
                    <View style={styles.profileInner}>
                        <View style={styles.profileHeader}>
                            <TouchableOpacity onPress={openPhotoModal} style={styles.profileImageContainer}>
                                {user?.photoURL && (
                                    <Image source={{ uri: user.photoURL }} style={styles.profileImage} />
                                )}
                                <View style={styles.editIconContainer}>
                                    <Ionicons name="pencil" size={16} color="#fff" />
                                </View>
                            </TouchableOpacity>
                            <View style={styles.profileInfo}>
                                <EditableInfoRow
                                    size={24}
                                    bold={true}
                                    showLabel={false}
                                    label="Name"
                                    value={user?.displayName || 'Set Your Name'}
                                    onSave={async (name) => {
                                        const userToUpdate = auth.currentUser;
                                        if (!userToUpdate) throw new Error("User not found");
                                        await updateProfile(userToUpdate, { displayName: name });
                                        refreshAuthUser();
                                    }}
                                />
                            </View>
                        </View>
                        {user?.phoneNumber &&
                            <EditableInfoRow
                                label="Phone Number"
                                value={toReadablePhone(user?.phoneNumber) || 'Not set'}
                                onSave={handlePhoneSave}
                                editable={false}
                            />
                        }
                        {user?.email &&
                            <EditableInfoRow
                                label="Email"
                                value={user?.email || 'Not set'}
                                onSave={handleEmailSave}
                                editable={true}
                            />
                        }
                    </View>
                </View>

                {/* Groups Section */}
                <View style={styles.groupsContainer}>
                    <View style={styles.sectionHeader}>
                        <Text style={styles.sectionTitle}>My Groups</Text>
                        <TouchableOpacity style={styles.addButton} onPress={openCreateGroupModal}>
                            <Ionicons name="add" size={24} color="#fff" />
                        </TouchableOpacity>
                    </View>
                    {groups.length === 0 ? (
                        <View style={styles.emptyContainer}>
                            <Ionicons name="people-outline" size={40} color="#ccc" style={styles.emptyIcon} />
                            <Text style={styles.emptySubtitle}>Create or join a group to start sharing lists.</Text>
                        </View>
                    ) : (
                        <FlatList
                            data={groups}
                            keyExtractor={(g) => g.id}
                            scrollEnabled={false}
                            renderItem={({ item }) => (
                                <TouchableOpacity style={styles.groupItem} onPress={() => navigateToList(item)}>
                                    <Text style={styles.groupName}>{item.name}</Text>
                                    <Ionicons name="chevron-forward" size={20} color="#ccc" />
                                </TouchableOpacity>
                            )}
                        />
                    )}
                </View>
            </ScrollView>

            {/* --- Create Group Modal --- */}
            <Modal visible={isGroupModalVisible} animationType="slide">
                <SafeAreaView style={styles.modalViewContainer}>
                    {/* FIX: Replaced ScrollView with a single FlatList.
                      The searchResults are the main data for this list.
                    */}
                    <FlatList
                        contentContainerStyle={styles.modalScrollView}
                        // Use searchResults as the primary data source
                        data={searchResults}
                        keyExtractor={(item) => item.uid}
                        // Header contains all content BEFORE the search results list
                        ListHeaderComponent={
                            <>
                                <Text style={styles.modalTitle}>Create New Group</Text>

                                <Text style={styles.inputLabel}>Group Name</Text>
                                <TextInput
                                    style={styles.textInput}
                                    placeholder="Family, Roommates, etc."
                                    value={newGroupName}
                                    onChangeText={setNewGroupName}
                                />

                                <Text style={styles.inputLabel}>Invite Members</Text>
                                <TextInput
                                    style={styles.textInput}
                                    placeholder="Search by name, email, or phone"
                                    value={searchQuery}
                                    onChangeText={handleSearchChange}
                                />

                                {isSearching && <ActivityIndicator style={{ marginVertical: 10 }} />}
                            </>
                        }
                        // renderItem handles the main list data (the search results)
                        renderItem={({ item }) => (
                            <View style={styles.userItem}>
                                <Image source={{ uri: item.photoURL || defaultAvatars[0] }} style={styles.userAvatar} />
                                <View style={styles.userInfo}>
                                    <Text style={styles.userName}>{item.displayName}</Text>
                                    <Text style={styles.userContact}>{item.phoneNumber ? toReadablePhone(item.phoneNumber) : item.email}</Text>
                                </View>
                                <TouchableOpacity style={styles.inlineButton} onPress={() => handleInviteUser(item)}>
                                    <Text style={styles.inlineButtonText}>Invite</Text>
                                </TouchableOpacity>
                            </View>
                        )}
                        // Footer contains all content AFTER the search results list
                        ListFooterComponent={
                            <>
                                {invitedMembers.length > 0 && (
                                    <>
                                        <Text style={styles.inputLabel}>Invited</Text>
                                        {/* FIX: Use a simple map for the short list of invited members
                                          to avoid nesting a VirtualizedList.
                                        */}
                                        {invitedMembers.map((item) => (
                                            <View key={item.uid} style={styles.userItem}>
                                                <Image source={{ uri: item.photoURL || defaultAvatars[0] }} style={styles.userAvatar} />
                                                <View style={styles.userInfo}>
                                                  <Text style={styles.userName}>{item.displayName}</Text>
                                                </View>
                                                <TouchableOpacity onPress={() => handleRemoveUser(item)}>
                                                    <Ionicons name="close-circle" size={24} color="#ff3b30" />
                                                </TouchableOpacity>
                                            </View>
                                        ))}
                                    </>
                                )}
                            </>
                        }
                    />

                    {/* The action buttons remain outside the list to stay at the bottom */}
                    <View style={styles.modalFooter}>
                        <TouchableOpacity style={[styles.modalButton, styles.secondaryButton]} onPress={() => setGroupModalVisible(false)}>
                            <Text style={styles.secondaryButtonText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.modalButton, styles.primaryButton]} onPress={submitCreateGroup} disabled={loading}>
                            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Create Group</Text>}
                        </TouchableOpacity>
                    </View>
                </SafeAreaView>
            </Modal>


            {/* Photo Edit Modal (remains the same) */}
            <Modal visible={editModalVisible === 'photo'} animationType="slide" transparent={true}>
                <View style={styles.modalContainer}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>Update Profile Photo</Text>
                        {newPhotoUri && <Image source={{ uri: newPhotoUri }} style={styles.modalMainAvatar} />}

                        <View style={styles.carouselContainer}>
                            <TouchableOpacity style={[styles.arrowButton, isAtStart && styles.transparentButton]} onPress={() => scrollTo('left')}>
                                <Ionicons name="chevron-back" size={24} color="#666" />
                            </TouchableOpacity>
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
                                        return (
                                            <TouchableOpacity style={styles.uploadButton} onPress={handlePickImage}>
                                                <Ionicons name="camera-outline" size={24} color="#666" />
                                            </TouchableOpacity>
                                        );
                                    }
                                    return (
                                        <TouchableOpacity onPress={() => setNewPhotoUri(item)}>
                                            <Image source={{ uri: item }} style={[styles.gridAvatar, newPhotoUri === item && styles.selectedAvatar]} />
                                        </TouchableOpacity>
                                    );
                                }}
                            />
                            <TouchableOpacity style={[styles.arrowButton, isAtEnd && styles.transparentButton]} onPress={() => scrollTo('right')}>
                                <Ionicons name="chevron-forward" size={24} color="#666" />
                            </TouchableOpacity>
                        </View>

                        <View style={styles.modalButtons}>
                            <TouchableOpacity style={[styles.modalButton, styles.secondaryButton]} onPress={() => setEditModalVisible(null)}>
                                <Text style={styles.secondaryButtonText}>Cancel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[styles.modalButton, styles.primaryButton]} onPress={handlePhotoSave} disabled={loading}>
                                {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Save</Text>}
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#f8f9fa',
        paddingTop: Constants.statusBarHeight,
    },
    profileInner: {
        backgroundColor: '#fff',
        padding: 16,
        borderRadius: 8,
        borderColor: '#eee',
        borderWidth: 1,
    },
    profileHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingBottom: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#f0f0f0',
        marginBottom: 16
    },
    profileImageContainer: {
        marginRight: 16
    },
    profileImage: { width: 90, height: 90, borderRadius: 45, borderWidth: 2, borderColor: '#ecececff' },
    editIconContainer: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        backgroundColor: '#007AFF',
        borderRadius: 12,
        padding: 4,
        borderWidth: 2,
        borderColor: '#fff',
    },
    profileInfo: { flex: 1 },
    infoRow: {
        paddingVertical: 6,
    },
    infoLabel: {
        fontSize: 14,
        color: '#666',
        marginBottom: 4,
    },
    viewContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    infoValue: {
        fontSize: 16,
        fontWeight: '500',
    },
    editContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    infoInput: {
        flex: 1,
        fontSize: 16,
        borderWidth: 1,
        borderColor: '#ccc',
        borderRadius: 6,
        padding: 8,
        marginRight: 8,
    },
    editPencilButton: {
        width: 28,
        height: 28,
        borderRadius: 14,
        backgroundColor: '#007AFF',
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 2,
        borderColor: '#fff'
    },
    groupsContainer: {
        paddingHorizontal: 16,
        marginBottom: 16,
    },
    sectionHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    sectionTitle: { fontSize: 22, fontWeight: 'bold', marginVertical: 10 },
    addButton: {
        backgroundColor: '#007AFF',
        width: 36,
        height: 36,
        borderRadius: 18,
        justifyContent: 'center',
        alignItems: 'center',
    },
    groupItem: {
        backgroundColor: '#fff',
        padding: 16,
        borderRadius: 8,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 10,
        borderColor: '#eee',
        borderWidth: 1,
    },
    groupName: { fontSize: 16 },
    emptyContainer: {
        alignItems: 'center',
        paddingVertical: 40,
        backgroundColor: '#fff',
        borderRadius: 8,
        borderColor: '#eee',
        borderWidth: 1,
    },
    emptyIcon: { marginBottom: 16 },
    emptySubtitle: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 20, paddingHorizontal: 20 },

    primaryButton: {
        backgroundColor: '#007AFF',
        paddingVertical: 12,
        paddingHorizontal: 30,
        borderRadius: 25,
        alignItems: 'center',
        justifyContent: 'center',
    },
    primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
    secondaryButton: {
        backgroundColor: 'transparent',
        borderColor: '#007AFF',
        borderWidth: 1,
    },
    secondaryButtonText: {
        color: '#007AFF',
        fontSize: 16,
        fontWeight: '600',
    },
    inlineButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: '#007AFF',
        borderRadius: 15,
        marginLeft: 8,
    },
    inlineButtonText: {
        color: '#fff',
        fontWeight: '500'
    },
    inlineButtonSecondary: {
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    inlineButtonSecondaryText: {
        color: '#666',
        fontWeight: '500'
    },

    // --- Modal & Carousel Styles ---
    modalContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' },
    modalContent: { backgroundColor: 'white', padding: 20, borderRadius: 10, width: '90%', alignItems: 'center' },
    modalTitle: { fontSize: 24, fontWeight: 'bold', marginBottom: 20, alignSelf: 'center' },
    modalMainAvatar: { width: 100, height: 100, borderRadius: 50, backgroundColor: '#eee', marginBottom: 16 },
    modalButtons: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', marginTop: 20 },
    modalButton: {
        flex: 1,
        marginHorizontal: 8,
        paddingVertical: 12,
        borderRadius: 25,
        alignItems: 'center'
    },
    carouselContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        width: '100%',
    },
    arrowButton: {
        paddingHorizontal: 4,
    },
    transparentButton: {
        opacity: 0,
    },
    flatListContent: {
        paddingHorizontal: 10,
    },
    gridAvatar: { width: 60, height: 60, borderRadius: 30, margin: 5, backgroundColor: '#eee' },
    selectedAvatar: { borderWidth: 3, borderColor: '#007AFF' },
    uploadButton: { width: 60, height: 60, borderRadius: 30, margin: 5, backgroundColor: '#f0f0f0', justifyContent: 'center', alignItems: 'center' },
    
    // --- New Styles for Create Group Modal ---
    modalViewContainer: {
        flex: 1,
        backgroundColor: '#f8f9fa',
    },
    modalScrollView: {
        padding: 16,
    },
    inputLabel: {
        fontSize: 16,
        fontWeight: '500',
        color: '#333',
        marginBottom: 8,
        marginTop: 16,
    },
    textInput: {
        backgroundColor: '#fff',
        borderWidth: 1,
        borderColor: '#ccc',
        borderRadius: 8,
        padding: 12,
        fontSize: 16,
    },
    userItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#fff',
        padding: 10,
        borderRadius: 8,
        marginBottom: 8,
    },
    userAvatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
        marginRight: 12,
    },
    userInfo: {
        flex: 1,
    },
    userName: {
        fontSize: 16,
        fontWeight: '600',
    },
    userContact: {
        fontSize: 14,
        color: '#666',
    },
    modalFooter: {
        flexDirection: 'row',
        padding: 16,
        borderTopWidth: 1,
        borderTopColor: '#eee',
        backgroundColor: '#fff',
    },
});