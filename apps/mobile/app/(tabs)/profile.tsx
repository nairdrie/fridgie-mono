import { useAuth } from '@/context/AuthContext';
import { Group } from '@/types/types';
import { createGroup } from '@/utils/api';
import { auth, storage } from '@/utils/firebase';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { updateEmail, updateProfile } from 'firebase/auth';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
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

// A reusable component for displaying and editing a single line of profile info
const EditableInfoRow = ({ label, value, onSave }: { label: string; value: string; onSave: (newValue: string) => Promise<void> }) => {
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
            <Text style={styles.infoLabel}>{label}</Text>
            {isEditing ? (
                <View style={styles.editContainer}>
                    <TextInput
                        style={styles.infoInput}
                        value={text}
                        onChangeText={setText}
                        autoFocus
                    />
                    <Button title="Save" onPress={handleSave} disabled={loading} />
                    <Button title="Cancel" color="#666" onPress={() => setIsEditing(false)} />
                </View>
            ) : (
                <View style={styles.viewContainer}>
                    <Text style={styles.infoValue}>{value}</Text>
                    <TouchableOpacity onPress={() => { setText(value); setIsEditing(true); }}>
                        <Ionicons name="pencil" size={20} color="#007AFF" />
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );
};


export default function UserProfile() {
    const router = useRouter();
    const { user, groups, selectGroup, refreshAuthUser } = useAuth();
    const [loading, setLoading] = useState(false);

    // State to manage which edit modal is visible
    const [editModalVisible, setEditModalVisible] = useState<'photo' | 'name' | null>(null);
    
    // State for the edit forms
    const [newName, setNewName] = useState(user?.displayName || '');
    const [newPhotoUri, setNewPhotoUri] = useState(user?.photoURL || null);

    const handleCreateGroup = async () => {
      const user = auth.currentUser;
      if (!user || user.isAnonymous) {
        router.push('/login');
        return;
      }

      try {
        const newGroup = await createGroup('New Group');
        // The `onAuthStateChanged` listener will handle refetching the groups,
        // but for immediate feedback you might want to optimistically update the state.
        // A full solution would add the new group to your `AuthContext` state.
      } catch (err) {
        console.error('failed to create group', err);
      }
    };

  const navigateToList = (group: Group) => {
    selectGroup(group);
    router.push('/list');
  };
  


  const handlePhotoSave = async () => {
    if (!newPhotoUri) return;
    setLoading(true);
    try {
      // This logic reuses the updateUserProfile logic from your other screen
      // but is adapted for just the photo.
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
      refreshAuthUser(); // Refresh the context
    } catch (err) {
      Alert.alert("Error", "Could not update profile picture.");
    } finally {
      setLoading(false);
      setEditModalVisible(null);
    }
  };

  const handleNameSave = async () => {
    setLoading(true);
    try {
        const userToUpdate = auth.currentUser;
        if (!userToUpdate) throw new Error("User not found");
        await updateProfile(userToUpdate, { displayName: newName });
        refreshAuthUser();
    } catch(err) {
        Alert.alert("Error", "Could not update name.");
    } finally {
        setLoading(false);
        setEditModalVisible(null);
    }
  };

  // --- Photo Picker Logic (adapted from your other screen) ---
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
            // Note: updateEmail may require recent sign-in for security reasons.
            // You may need to handle re-authentication errors here.
            await updateEmail(userToUpdate, newEmail);
            refreshAuthUser();
        } catch (error) {
            console.error(error);
            // Provide a more helpful error for common cases
            throw new Error("Failed to update email. You may need to sign out and sign back in.");
        }
    };
    
    const handlePhoneSave = async (newPhone: string) => {
        // Firebase phone number updates require a full re-verification flow (sending a new SMS).
        // This is a complex process and is stubbed out here.
        Alert.alert("Feature Coming Soon", "Updating your phone number requires re-verification.");
    };

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView>
                {/* --- Expanded Profile Card --- */}
                <View style={styles.profileCard}>
                    <View style={styles.profileHeader}>
                        <TouchableOpacity onPress={() => setEditModalVisible(true)} style={styles.profileImageContainer}>
                            {user?.photoURL && (
                                <Image source={{ uri: user.photoURL }} style={styles.profileImage} />
                            )}
                            <View style={styles.editIconContainer}>
                                <Ionicons name="pencil" size={16} color="#fff" />
                            </View>
                        </TouchableOpacity>
                        <View style={styles.profileInfo}>
                            <Text style={styles.displayName}>{user?.displayName || 'Set Your Name'}</Text>
                            {/* We can re-add the name edit here if needed */}
                        </View>
                    </View>

                    <EditableInfoRow 
                        label="Phone Number" 
                        value={user?.phoneNumber || 'Not set'} 
                        onSave={handlePhoneSave}
                    />
                    <EditableInfoRow 
                        label="Email" 
                        value={user?.email || 'Not set'} 
                        onSave={handleEmailSave}
                    />
                </View>

                {/* --- Groups Section --- */}
                <View style={styles.groupsContainer}>
                    <Text style={styles.sectionTitle}>Your Groups</Text>
                    {groups.length <= 1 ? (
                        <View style={styles.emptyContainer}>
                            <Ionicons name="people" size={80} color="#ccc" style={styles.emptyIcon} />
                             <Text style={styles.emptySubtitle}>Create a group to start sharing lists.</Text>
                            <TouchableOpacity style={styles.primaryButton} onPress={handleCreateGroup}>
                                <Text style={styles.primaryButtonText}>Create a Group</Text>
                            </TouchableOpacity>
                        </View>
                    ) : (
                        <FlatList
                            data={groups}
                            keyExtractor={(g) => g.id}
                            scrollEnabled={false} // The parent ScrollView handles scrolling
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

            {/* --- Photo Edit Modal --- */}
            <Modal visible={editModalVisible} animationType="slide">
                {/* For simplicity, this is a basic photo modal. You can add the carousel here. */}
                <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={styles.modalTitle}>Update Profile Photo</Text>
                    {newPhotoUri && <Image source={{ uri: newPhotoUri }} style={styles.profileImage} />}
                    <Button title="Choose from Library" onPress={handlePickImage} />
                    <View style={styles.modalButtons}>
                        <Button title="Cancel" onPress={() => setEditModalVisible(false)} />
                        <Button title="Save" onPress={handlePhotoSave} disabled={loading} />
                    </View>
                    {loading && <ActivityIndicator />}
                </SafeAreaView>
            </Modal>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#f8f9fa',
        marginTop: Constants.statusBarHeight,
    },
    // --- New Profile Card Styles ---
    profileCard: {
        backgroundColor: '#fff',
        margin: 16,
        borderRadius: 12,
        padding: 16,
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 3.84,
        elevation: 5,
    },
    profileHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingBottom: 16,
        marginBottom: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#f0f0f0',
    },
    profileImageContainer: { marginRight: 16 },
    profileImage: { width: 70, height: 70, borderRadius: 35 },
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
    displayName: { fontSize: 24, fontWeight: 'bold' },
    
    // --- EditableInfoRow Styles ---
    infoRow: {
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#f0f0f0',
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

    // --- Groups Section Styles ---
    groupsContainer: {
        paddingHorizontal: 16,
    },
    sectionTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 10 },
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

    // --- Empty State Styles ---
    emptyContainer: {
        alignItems: 'center',
        paddingVertical: 40,
        backgroundColor: '#fff',
        borderRadius: 8,
        borderColor: '#eee',
        borderWidth: 1,
    },
    emptyIcon: { fontSize: 40, color: '#d0d0d0', marginBottom: 16 },
    emptyTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
    emptySubtitle: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 20, paddingHorizontal: 20 },
    primaryButton: { backgroundColor: '#007AFF', paddingVertical: 12, paddingHorizontal: 30, borderRadius: 25 },
    primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },

    // --- Modal Styles ---
    modalContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' },
    modalContent: { backgroundColor: 'white', padding: 20, borderRadius: 10, width: '85%', alignItems: 'center' },
    modalTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 20 },
    modalButtons: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', marginTop: 20 },
});