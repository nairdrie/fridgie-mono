import { useAuth } from '@/context/AuthContext';
import { Group, PendingInvitation, UserProfile } from '@/types/types';
import { ApiError, createGroup, declineGroupInvitation, deleteGroup, getPendingInvitations, searchUsers, sendGroupInvitation, updateGroup } from '@/utils/api';
import { defaultAvatars } from '@/utils/defaultAvatars';
import { auth } from '@/utils/firebase';
import { primary } from '@/utils/styles';
import { toReadablePhone } from '@/utils/utils';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { User } from 'firebase/auth';
import { debounce } from 'lodash';
import React, { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Image,
    LayoutAnimation,
    Modal,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';

/**
 * A self-contained component for rendering and managing a single group item.
 */
const GroupItem = ({ group, isSelected, isExpanded, onSelect, onToggleExpand, onGroupUpdated }: {
    group: Group;
    isSelected: boolean;
    isExpanded: boolean;
    onSelect: (group: Group) => void;
    onToggleExpand: (group: Group) => void;
    onGroupUpdated: () => void;
}) => {
    // --- State for the expanded/editing view ---
    const [members, setMembers] = useState<UserProfile[]>([]);
    const [initialMembers, setInitialMembers] = useState<UserProfile[]>([]);
    const [newlyInvited, setNewlyInvited] = useState<User[]>([]);
    const [pendingInvites, setPendingInvites] = useState<PendingInvitation[]>([]);
    const [isSaving, setIsSaving] = useState(false);
    const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

    // Editing state
    const [editedName, setEditedName] = useState(group.name);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<User[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    const isOwner = auth.currentUser?.uid === group.owner;
    const canEdit = isOwner && group.name !== 'Private';

    // Reset component state when it's expanded or the group data changes
    useEffect(() => {
        if (isExpanded) {
            const currentMembers = group.members || [];
            setMembers(currentMembers);
            setInitialMembers(currentMembers);
            setNewlyInvited([]);
            setEditedName(group.name);
            setSearchQuery('');
            setSearchResults([]);
            setIsConfirmingDelete(false);
            setPendingInvites([]);

            const fetchDetails = async () => {
                if (canEdit) { // Only owners should see pending invites
                    try {
                        const invites = await getPendingInvitations(group.id);
                        setPendingInvites(invites);
                    } catch (error) {
                        console.error("Failed to fetch pending invitations:", error);
                    }
                }
            };
            fetchDetails();
        }
    }, [isExpanded, group]);

    const debouncedSearch = React.useCallback(
        debounce(async (query: string) => {
            if (query.length < 2) {
                setSearchResults([]);
                setIsSearching(false);
                return;
            }
            try {
                const results = await searchUsers(query);
                const currentUserUid = auth.currentUser?.uid;
                const existingMemberUids = new Set(members.map(m => m.uid));
                const newlyInvitedUids = new Set(newlyInvited.map(m => m.uid));
                const pendingInviteUids = new Set(pendingInvites.map(i => i.invitee.uid));

                const filteredResults = results.filter(u =>
                    u.uid !== currentUserUid &&
                    !existingMemberUids.has(u.uid) &&
                    !newlyInvitedUids.has(u.uid) &&
                    !pendingInviteUids.has(u.uid)
                );
                setSearchResults(filteredResults);
            } catch (error) {
                console.error("Search failed:", error);
            } finally {
                setIsSearching(false);
            }
        }, 300),
        [members, newlyInvited, pendingInvites]
    );

    const handleSearchChange = (text: string) => {
        setSearchQuery(text);
        setIsSearching(true);
        debouncedSearch(text);
    };

    const handleStageInvite = (userToInvite: User) => {
        setNewlyInvited(prev => [...prev, userToInvite]);
        setSearchResults(prev => prev.filter(u => u.uid !== userToInvite.uid));
    };

    const handleRemoveStagedInvite = (userToUninvite: User) => {
        setNewlyInvited(prev => prev.filter(u => u.uid !== userToUninvite.uid));
    };

    const handleStageRemoval = (userToRemove: UserProfile) => {
        setMembers(prev => prev.filter(m => m.uid !== userToRemove.uid));
    };

    const handleRevokeInvitation = async (invitation: PendingInvitation) => {
        Alert.alert(
            "Revoke Invitation",
            `Are you sure you want to revoke the invitation for ${invitation.invitee.displayName}?`,
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Revoke",
                    style: "destructive",
                    onPress: async () => {
                        try {
                            await declineGroupInvitation(invitation.id);
                            setPendingInvites(prev => prev.filter(i => i.id !== invitation.id));
                            Alert.alert("Success", "Invitation has been revoked.");
                        } catch (error) {
                            const message = error instanceof ApiError ? error.message : "Could not revoke invitation.";
                            Alert.alert("Error", message);
                        }
                    },
                },
            ]
        );
    };

    const handleSaveChanges = async () => {
        setIsSaving(true);
        try {
            const promises = [];
            const initialMemberUids = new Set(initialMembers.map(m => m.uid));
            const currentMemberUids = new Set(members.map(m => m.uid));
            const membersChanged = initialMemberUids.size !== currentMemberUids.size || ![...initialMemberUids].every(uid => currentMemberUids.has(uid));
            const nameChanged = editedName.trim() !== group.name;

            if (nameChanged || membersChanged) {
                promises.push(
                    updateGroup(group.id, {
                        name: editedName.trim(),
                        members: members.map(m => m.uid)
                    })
                );
            }

            for (const userToInvite of newlyInvited) {
                promises.push(sendGroupInvitation(group.id, userToInvite.uid));
            }

            if (promises.length === 0) {
                onToggleExpand(group);
                return;
            }

            await Promise.all(promises);
            Alert.alert("Success", "Group changes have been saved.");
            onGroupUpdated();
            onToggleExpand(group);

        } catch (error) {
            const message = error instanceof ApiError ? error.message : "An error occurred while saving.";
            Alert.alert("Error", message);
        } finally {
            setIsSaving(false);
        }
    };
    
    const handleDeleteGroup = async () => {
        try {
            await deleteGroup(group.id);
            setIsConfirmingDelete(false);
            onGroupUpdated();
        } catch (error) {
            const message = error instanceof ApiError ? error.message : "Could not delete the group.";
            Alert.alert("Error", message);
        }
    };

    return (
        <View style={styles.groupItemContainer}>
            <View style={styles.groupItem}>
                <TouchableOpacity style={styles.groupSelectableArea} onPress={() => onSelect(group)}>
                    <Ionicons name={isSelected ? "checkmark-circle" : "ellipse-outline"} size={24} color={isSelected ? primary : "#ccc"} />
                    <Text style={styles.groupName}>{group.name}</Text>
                    {isSelected && <Text style={styles.selectedText}>(Selected)</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={styles.expandButton} onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); onToggleExpand(group); }}>
                    <Ionicons name={isExpanded ? "chevron-up-outline" : "chevron-down-outline"} size={24} color="#666" />
                </TouchableOpacity>
            </View>

            {isExpanded && (
                <View style={styles.expandedContent}>
                    <Text style={styles.inputLabel}>Group Name</Text>
                    <TextInput style={[styles.textInput, !canEdit && styles.readOnlyInput]} value={editedName} onChangeText={setEditedName} editable={canEdit} />

                    <Text style={styles.inputLabel}>Members</Text>
                    {members.map(member => (
                        <View key={member.uid} style={styles.userItem}>
                            <Image source={{ uri: member.photoURL || defaultAvatars[0] }} style={styles.userAvatar} />
                            <Text style={styles.userName}>{member.displayName}</Text>
                            {canEdit && member.uid !== group.owner && (
                                <TouchableOpacity onPress={() => handleStageRemoval(member)}>
                                    <Ionicons name="close-circle" size={24} color="#ccc" />
                                </TouchableOpacity>
                            )}
                        </View>
                    ))}

                    {canEdit && pendingInvites.length > 0 && (
                        <>
                            <Text style={styles.inputLabel}>Pending Invitations</Text>
                            {pendingInvites.map(invite => (
                                <View key={invite.id} style={[styles.userItem, styles.pendingItem]}>
                                    <Image source={{ uri: invite.invitee.photoURL || defaultAvatars[0] }} style={styles.userAvatar} />
                                    <View style={styles.userInfo}>
                                        <Text style={styles.userName}>{invite.invitee.displayName}</Text>
                                        <Text style={styles.userContact}>(Invited)</Text>
                                    </View>
                                    <TouchableOpacity onPress={() => handleRevokeInvitation(invite)}>
                                        <Ionicons name="close-circle" size={24} color="#ff9500" />
                                    </TouchableOpacity>
                                </View>
                            ))}
                        </>
                    )}

                    {canEdit && (
                        <>
                            <Text style={styles.inputLabel}>Invite New Members</Text>
                            <TextInput style={styles.textInput} placeholder="Search by name, email, or phone" value={searchQuery} onChangeText={handleSearchChange} />
                            
                            {isSearching && <ActivityIndicator style={{marginVertical: 10}}/>}
                            
                            {searchResults.map(user => (
                                <View key={user.uid} style={styles.userItem}>
                                    <Image source={{ uri: user.photoURL || defaultAvatars[0] }} style={styles.userAvatar} />
                                    <View style={styles.userInfo}><Text style={styles.userName}>{user.displayName}</Text></View>
                                    <TouchableOpacity style={styles.inlineButton} onPress={() => handleStageInvite(user)}>
                                        <Text style={styles.inlineButtonText}>Invite</Text>
                                    </TouchableOpacity>
                                </View>
                            ))}
                            
                            {newlyInvited.length > 0 && (
                                <>
                                    <Text style={styles.inputLabel}>Staged Invitations</Text>
                                    {newlyInvited.map(user => (
                                        <View key={user.uid} style={[styles.userItem, styles.stagedItem]}>
                                            <Image source={{ uri: user.photoURL || defaultAvatars[0] }} style={styles.userAvatar} />
                                            <View style={styles.userInfo}><Text style={styles.userName}>{user.displayName}</Text></View>
                                            <TouchableOpacity onPress={() => handleRemoveStagedInvite(user)}>
                                                <Ionicons name="close-circle" size={24} color="#ff3b30" />
                                            </TouchableOpacity>
                                        </View>
                                    ))}
                                </>
                            )}
                        </>
                    )}
                    
                    <View style={styles.modalFooter}>
                        {canEdit ? (
                            <>
                                <TouchableOpacity style={[styles.modalButton, styles.secondaryButton]} onPress={() => onToggleExpand(group)}>
                                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                                </TouchableOpacity>
                                <TouchableOpacity style={[styles.modalButton, styles.primaryButton]} onPress={handleSaveChanges} disabled={isSaving}>
                                    {isSaving ? <ActivityIndicator color="#fff"/> : <Text style={styles.primaryButtonText}>Save Changes</Text>}
                                </TouchableOpacity>
                            </>
                        ) : (
                             <TouchableOpacity style={[styles.modalButton, styles.secondaryButton]} onPress={() => onToggleExpand(group)}>
                                <Text style={styles.secondaryButtonText}>Close</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                    
                    {canEdit && (
                        <View style={styles.deleteSection}>
                            {isConfirmingDelete ? (
                                <View style={styles.confirmationContainer}>
                                    <Text style={styles.confirmationText}>Are you sure?</Text>
                                    <View style={{ flexDirection: 'row' }}>
                                        <TouchableOpacity style={[styles.confirmButton, styles.cancelButton]} onPress={() => setIsConfirmingDelete(false)}>
                                            <Text style={styles.cancelButtonText}>Cancel</Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity style={[styles.confirmButton, styles.deleteConfirmButton]} onPress={handleDeleteGroup}>
                                            <Text style={styles.deleteConfirmButtonText}>Delete</Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>
                            ) : (
                                <TouchableOpacity style={styles.deleteButton} onPress={() => setIsConfirmingDelete(true)}>
                                    <Ionicons name="trash-outline" size={16} color="#c94444" />
                                    <Text style={styles.deleteButtonText}>Delete Group</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    )}
                </View>
            )}
        </View>
    );
};


export default function GroupsScreen() {
    const router = useRouter();
    const { groups, selectedGroup, selectGroup, refreshAuthUser } = useAuth();
    const [loading, setLoading] = useState(false);
    
    const [isGroupModalVisible, setGroupModalVisible] = useState(false);
    const [newGroupName, setNewGroupName] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<User[]>([]);
    const [invitedMembers, setInvitedMembers] = useState<User[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    
    const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);

    const debouncedSearch = useCallback(
        debounce(async (query: string) => {
            if (query.length < 2) {
                setSearchResults([]);
                setIsSearching(false);
                return;
            }
            try {
                const results = await searchUsers(query);
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
        }, 300),
        [invitedMembers]
    );
    
    const handleSearchChange = (text: string) => {
        setSearchQuery(text);
        setIsSearching(true);
        debouncedSearch(text);
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
        if (!auth.currentUser?.uid) {
            // Handle case where user is not logged in
            return;
        }

        setLoading(true);

        try {
            // ONE API call to create the group and send invitations
            const inviteeUids = invitedMembers.map(member => member.uid);
            await createGroup(newGroupName, inviteeUids);
            
            Alert.alert("Success", `Group "${newGroupName}" created and invitations sent.`);
            refreshAuthUser(); // Refresh the user's groups
            setGroupModalVisible(false); // Close the modal

        } catch (err) {
            console.error(err);
            const message = err instanceof ApiError ? err.message : "Could not create the group.";
            Alert.alert('Error', message);
        
        } finally {
            setLoading(false);
        }
    };

    const openCreateGroupModal = () => {
        if (!auth.currentUser || auth.currentUser.isAnonymous) {
            router.push('/login');
            return;
        }
        setNewGroupName('');
        setSearchQuery('');
        setSearchResults([]);
        setInvitedMembers([]);
        setGroupModalVisible(true);
    };
    
    const handleSelectGroup = (group: Group) => {
        selectGroup(group);
    };

    const handleToggleExpand = (group: Group) => {
        setExpandedGroupId(prevId => (prevId === group.id ? null : group.id));
    };

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView>
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
                    
                    {groups.map(item => (
                        <GroupItem
                            key={item.id}
                            group={item}
                            isSelected={selectedGroup?.id === item.id}
                            isExpanded={expandedGroupId === item.id}
                            onSelect={handleSelectGroup}
                            onToggleExpand={handleToggleExpand}
                            onGroupUpdated={refreshAuthUser}
                        />
                    ))}

                    {groups.length === 0 && (
                         <View style={styles.emptyContainer}>
                            <Ionicons name="people-outline" size={40} color="#ccc" style={styles.emptyIcon} />
                            <Text style={styles.emptySubtitle}>Create or join a group to start sharing lists.</Text>
                            <TouchableOpacity style={styles.primaryButton} onPress={openCreateGroupModal}>
                                <Text style={styles.primaryButtonText}>Create Group</Text>
                            </TouchableOpacity>
                       </View>
                    )}
                </View>
            </ScrollView>

            <Modal visible={isGroupModalVisible} animationType="slide">
                <SafeAreaView style={styles.modalViewContainer}>
                    <FlatList
                        contentContainerStyle={styles.modalScrollView}
                        data={searchResults}
                        keyExtractor={(item) => item.uid}
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
                        ListFooterComponent={
                            <>
                                {invitedMembers.length > 0 && (
                                    <>
                                        <Text style={styles.inputLabel}>Invited</Text>
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
    container: { flex: 1, backgroundColor: '#f8f9fa', paddingTop: Constants.statusBarHeight },
    groupsContainer: { paddingHorizontal: 16, marginBottom: 16 },
    sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
    headerLeft: { flexDirection: 'row', alignItems: 'center' },
    sectionTitle: { fontSize: 22, fontWeight: 'bold' },
    addButton: { backgroundColor: primary, width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
    backButton: { paddingRight: 10 },
    emptyContainer: { alignItems: 'center', paddingVertical: 40 },
    emptyIcon: { marginBottom: 16 },
    emptySubtitle: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 20, paddingHorizontal: 20 },
    primaryButton: { backgroundColor: primary, paddingVertical: 12, paddingHorizontal: 30, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
    primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
    modalViewContainer: { flex: 1, backgroundColor: '#f8f9fa' },
    modalScrollView: { padding: 16 },
    modalTitle: { fontSize: 24, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
    
    // Shared styles for user items
    userItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', padding: 10, borderRadius: 8, marginBottom: 8 },
    userAvatar: { width: 40, height: 40, borderRadius: 20, marginRight: 12, borderWidth:1,borderColor:'#ddd' },
    userInfo: { flex: 1 },
    userName: { fontSize: 16, fontWeight: '500', marginRight:10 },
    userContact: { fontSize: 14, color: '#666' },
    inlineButton: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: primary, borderRadius: 15, marginLeft: 8 },
    inlineButtonText: { color: '#fff', fontWeight: '500' },
    stagedItem: { backgroundColor: '#eef5ff' },
    pendingItem: { backgroundColor: '#fffbe6' },
    
    // Styles for Create/Edit Modals/Views
    inputLabel: { fontSize: 14, fontWeight: '500', color: '#333', marginBottom: 8, marginTop: 10 },
    textInput: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, fontSize: 16, marginBottom: 10 },
    readOnlyInput: { backgroundColor: '#f0f0f0', color: '#666' },
    modalFooter: { flexDirection: 'row', paddingVertical: 16, marginTop: 16, borderTopWidth: 1, borderTopColor: '#eee', backgroundColor: '#fff', paddingHorizontal: 8 },
    modalButton: { flex: 1, marginHorizontal: 8, paddingVertical: 12, borderRadius: 25, alignItems: 'center' },
    secondaryButton: { backgroundColor: '#e9ecef' },
    secondaryButtonText: { color: '#495057', fontSize: 16, fontWeight: '600' },

    // Styles for GroupItem
    groupItemContainer: { backgroundColor: '#fff', borderRadius: 8, marginBottom: 10, borderColor: '#eee', borderWidth: 1, overflow: 'hidden' },
    groupItem: { paddingVertical: 12, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    groupSelectableArea: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 10 },
    groupName: { fontSize: 16, marginLeft: 12 },
    selectedText: { fontSize: 14, fontStyle: 'italic', color: primary, marginLeft: 8 },
    expandButton: { padding: 5 },
    
    // Styles for Expanded View
    expandedContent: { paddingHorizontal: 16, paddingBottom: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#f0f0f0' },
    deleteSection: { paddingTop: 15, marginTop: 15, borderTopWidth: 1, borderTopColor: '#f0f0f0' },
    deleteButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 10 },
    deleteButtonText: { color: '#c94444', fontWeight: '600', marginLeft: 8 },
    confirmationContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    confirmationText: { fontSize: 14, fontWeight: '500' },
    confirmButton: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 20 },
    cancelButton: { backgroundColor: '#e9ecef' },
    cancelButtonText: { fontWeight: '600' },
    deleteConfirmButton: { backgroundColor: '#c94444', color: 'white', marginLeft: 8 },
    deleteConfirmButtonText: { color: 'white' }
});

