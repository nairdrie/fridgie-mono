// screens/UserProfile.tsx

import { useAuth } from '@/context/AuthContext';
import { Group } from '@/types/types';
import { createGroup, searchUsers } from '@/utils/api'; // Import searchUsers
import { defaultAvatars } from '@/utils/defaultAvatars';
import { auth } from '@/utils/firebase';
import { primary } from '@/utils/styles';
import { toReadablePhone } from '@/utils/utils';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { User } from 'firebase/auth';
import { debounce } from 'lodash';
import React, { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Image,
    Modal,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';

export default function GroupsScreen() {
    const router = useRouter();
    const { groups, selectedGroup, selectGroup, refreshAuthUser } = useAuth();
    const [loading, setLoading] = useState(false);

    // --- Create Group Modal State ---
    const [isGroupModalVisible, setGroupModalVisible] = useState(false);
    const [newGroupName, setNewGroupName] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<User[]>([]);
    const [invitedMembers, setInvitedMembers] = useState<User[]>([]);
    const [isSearching, setIsSearching] = useState(false);


    
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
    
    const handleSelectGroup = (group: Group) => {
        selectGroup(group);
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

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView>
                {/* Groups Section */}
                <View style={styles.groupsContainer}>
                    <View style={styles.sectionHeader}>
                        <View style={styles.headerLeft}>
                            <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
                                <Ionicons name="chevron-back-outline" size={30} color="black" />
                            </TouchableOpacity>
                            <Text style={styles.sectionTitle}>My Groups</Text>
                        </View>
                        <TouchableOpacity style={styles.addButton} onPress={openCreateGroupModal}>
                            <Ionicons name="add" size={24} color="#fff" />
                        </TouchableOpacity>
                    </View>
                    <FlatList
                            data={groups}
                            keyExtractor={(g) => g.id}
                            scrollEnabled={false}
                            renderItem={({ item }) => (
                                <TouchableOpacity style={styles.groupItem} onPress={() => handleSelectGroup(item)}>
                                    <Text style={styles.groupName}>{item.name}</Text>
                                    { selectedGroup?.id === item.id ? (
                                        <View style={styles.viewContainer}>
                                            <Ionicons name="checkmark-circle" size={24} color={primary} />
                                        </View>
                                    ) : (
                                        <View style={styles.viewContainer}>
                                            <Ionicons name="ellipse-outline" size={24} color="#ccc" />
                                        </View>
                                    )}
                                </TouchableOpacity>
                            )}
                        />

                        <View style={styles.emptyContainer}>
                            <Ionicons name="people-outline" size={40} color="#ccc" style={styles.emptyIcon} />
                            <Text style={styles.emptySubtitle}>Create or join a group to start sharing lists.</Text>
                            <TouchableOpacity style={styles.primaryButton} onPress={openCreateGroupModal}>
                                <Text style={styles.primaryButtonText}>Create Group</Text>
                            </TouchableOpacity>
                        </View>

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
                                    placeholderTextColor={'grey'}
                                    value={newGroupName}
                                    onChangeText={setNewGroupName}
                                />

                                <Text style={styles.inputLabel}>Invite Members</Text>
                                <TextInput
                                    style={styles.textInput}
                                    placeholderTextColor={'grey'}
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
        paddingBottom: 24,
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
        backgroundColor: primary,
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
    headerLeft: {
        flexDirection: 'row',
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
        backgroundColor: primary,
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
        marginBottom:15
    },
    sectionTitle: { fontSize: 22, fontWeight: 'bold', marginVertical: 10 },
    addButton: {
        backgroundColor: primary,
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
    },
    emptyIcon: { marginBottom: 16 },
    emptySubtitle: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 20, paddingHorizontal: 20 },

    primaryButton: {
        backgroundColor: primary,
        paddingVertical: 12,
        paddingHorizontal: 30,
        borderRadius: 25,
        alignItems: 'center',
        justifyContent: 'center',
    },
    primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
    secondaryButton: {
        backgroundColor: 'transparent',
        borderColor: primary,
        borderWidth: 1,
    },
    secondaryButtonText: {
        color: primary,
        fontSize: 16,
        fontWeight: '600',
    },
    inlineButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: primary,
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
    backButton: {
        paddingRight: 10
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
    selectedAvatar: { borderWidth: 3, borderColor: primary },
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
    editMealPreferences: {
        marginTop: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
    },
    editMealPreferencesText: {
        color: primary,
        fontSize: 16,
        fontWeight: '500',
        marginLeft: 5
    }
});