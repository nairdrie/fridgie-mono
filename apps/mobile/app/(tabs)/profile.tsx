import { useAuth } from '@/context/AuthContext';
import { Group } from '@/types/types';
import { createGroup } from '@/utils/api';
import { defaultAvatars } from '@/utils/defaultAvatars';
import { auth, storage } from '@/utils/firebase';
import { toReadablePhone } from '@/utils/utils';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { updateEmail, updateProfile } from 'firebase/auth';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import React, { useRef, useState } from 'react';
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

// A reusable component for displaying and editing a single line of profile info
const EditableInfoRow = ({ label, value, onSave, showLabel = true, size = 16, bold = false, editable = true, placeholder="" }: { placeholder?: string, editable?: boolean, label: string; value: string; showLabel?: boolean; onSave: (newValue: string) => Promise<void>, size?: number, bold?: boolean }) => {
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
    const [editModalVisible, setEditModalVisible] = useState<'photo' | 'name' | null>(null);
    const [newPhotoUri, setNewPhotoUri] = useState(user?.photoURL || null);

    // --- Carousel State and Logic ---
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

    // --- Core Functions ---
    const handleCreateGroup = async () => {
        if (!auth.currentUser || auth.currentUser.isAnonymous) {
            router.push('/login');
            return;
        }
        try {
            await createGroup('New Group');
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
                        { user?.phoneNumber &&
                            <EditableInfoRow
                                label="Phone Number"
                                value={toReadablePhone(user?.phoneNumber) || 'Not set'}
                                onSave={handlePhoneSave}
                                editable={false}
                            />
                        }
                        {
                            user?.email &&
                            <EditableInfoRow
                                label="Email"
                                value={user?.email || 'Not set'}
                                onSave={handleEmailSave}
                                editable={false}
                            />
                        }
                    </View>
                </View>

                <View style={styles.groupsContainer}>
                    <Text style={styles.sectionTitle}>My Groups</Text>
                    {groups.length <= 1 ? (
                        <View style={styles.emptyContainer}>
                            <Ionicons name="people-outline" size={40} color="#ccc" style={styles.emptyIcon} />
                            <Text style={styles.emptySubtitle}>Create a group to start sharing lists.</Text>
                            <TouchableOpacity style={styles.primaryButton} onPress={handleCreateGroup}>
                                <Text style={styles.primaryButtonText}>Create a Group</Text>
                            </TouchableOpacity>
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

            {/* --- Photo Edit Modal with Carousel --- */}
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
        paddingVertical: 12,
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
    sectionTitle: { fontSize: 22, fontWeight: 'bold', marginVertical: 10 },
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
    
    // --- Button Styles ---
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
    modalTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 16 },
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
});