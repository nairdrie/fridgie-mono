import { useAuth } from '@/context/AuthContext';
import { defaultAvatars } from '@/utils/defaultAvatars';
import { auth, storage } from '@/utils/firebase';
import { toReadablePhone } from '@/utils/utils'; // Assuming this utility is still needed for the settings modal
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

// Reusable component for editable text fields, now only used in SettingsModal
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

// New Settings Modal Component
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

    const handlePhoneSave = async (newPhone: string) => {
        Alert.alert("Feature Coming Soon", "Updating your phone number requires re-verification.");
    };

    return (
        <Modal visible={isVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
            <SafeAreaView style={styles.modalViewContainer}>
                <View style={styles.modalHeader}>
                    <Text style={styles.modalHeaderTitle}>Settings</Text>
                    <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                        <Ionicons name="close-circle-outline" size={30} color="#007AFF" />
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
                            onSave={handlePhoneSave}
                            editable={false} // Phone number editable is currently disabled
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
                    <TouchableOpacity style={styles.editMealPreferences} onPress={() => router.push('/meal-preferences')}>
                        <Ionicons name="open-outline" size={16} color="#007AFF"></Ionicons>
                        <Text style={styles.editMealPreferencesText}>Edit Meal Preferences</Text>
                    </TouchableOpacity>

                    {/* Add other settings here */}

                    <TouchableOpacity style={[styles.primaryButton, { marginTop: 30, width: '100%' }]} onPress={() => {
                        auth.signOut();
                        onClose(); // Close modal after sign out
                    }}>
                        <Text style={styles.primaryButtonText}>Sign Out</Text>
                    </TouchableOpacity>

                </ScrollView>
            </SafeAreaView>
        </Modal>
    );
};


export default function UserProfile() {
    const { user, refreshAuthUser } = useAuth();
    const [loading, setLoading] = useState(false);
    const [editPhotoModalVisible, setEditPhotoModalVisible] = useState(false);
    const [settingsModalVisible, setSettingsModalVisible] = useState(false);
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
        if (!result.canceled) {
            setNewPhotoUri(result.assets[0].uri);
        }
    };

    const openPhotoModal = () => {
        setNewPhotoUri(user?.photoURL || null);
        setEditPhotoModalVisible(true);
    };

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => setSettingsModalVisible(true)} style={styles.settingsButton}>
                    <Ionicons name="settings-outline" size={28} color="#000" />
                </TouchableOpacity>
            </View>

            <ScrollView>
                {/* Profile Section */}
                <View style={styles.profileContainer}>
                    <TouchableOpacity onPress={openPhotoModal} style={styles.profileImageContainer}>
                        {user?.photoURL && (
                            <Image source={{ uri: user.photoURL }} style={styles.profileImage} />
                        )}
                        <View style={styles.editIconContainer}>
                            <Ionicons name="pencil" size={16} color="#fff" />
                        </View>
                    </TouchableOpacity>

                    <Text style={styles.displayName}>{user?.displayName || 'Set Your Name'}</Text>
                    {user?.email && <Text style={styles.usernameText}>@{user.email.split('@')[0]}</Text>} {/* Placeholder for username */}
                </View>

                {/* Stats Section */}
                <View style={styles.statsContainer}>
                    <View style={styles.statItem}>
                        <Text style={styles.statNumber}>0</Text>
                        <Text style={styles.statLabel}>Following</Text>
                    </View>
                    <View style={styles.statItem}>
                        <Text style={styles.statNumber}>0</Text>
                        <Text style={styles.statLabel}>Followers</Text>
                    </View>
                    <View style={styles.statItem}>
                        <Text style={styles.statNumber}>0</Text>
                        <Text style={styles.statLabel}>Recipes</Text>
                    </View>
                </View>

                {/* Recipe Feed Section */}
                <View style={styles.feedContainer}>
                    <Text style={styles.sectionTitle}>My Recipes</Text>
                    <View style={styles.feedPlaceholder}>
                        <Ionicons name="receipt-outline" size={48} color="#ccc" />
                        <Text style={styles.feedPlaceholderText}>Your saved recipes will appear here.</Text>
                    </View>
                </View>

            </ScrollView>

            {/* Photo Edit Modal */}
            <Modal visible={editPhotoModalVisible} animationType="slide" transparent={true}>
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
                            <TouchableOpacity style={[styles.modalButton, styles.secondaryButton]} onPress={() => setEditPhotoModalVisible(false)}>
                                <Text style={styles.secondaryButtonText}>Cancel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[styles.modalButton, styles.primaryButton]} onPress={handlePhotoSave} disabled={loading}>
                                {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Save</Text>}
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

            {/* Settings Modal */}
            <SettingsModal isVisible={settingsModalVisible} onClose={() => setSettingsModalVisible(false)} />

        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#f8f9fa',
        paddingTop: Constants.statusBarHeight,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'flex-end', // Center title
        paddingTop:20,
        paddingRight:20
    },
    headerTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        flex: 2, // Allow title to take more space
        textAlign: 'center',
    },
    settingsButton: {
        flex: 1, // Take up remaining space
        alignItems: 'flex-end',
    },
    profileContainer: {
        alignItems: 'center',
        paddingVertical: 24,
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
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 3,
        elevation: 5,
    },
    editIconContainer: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        backgroundColor: '#007AFF',
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
        marginBottom: 16, // Space before stats
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
    },
    sectionTitle: { 
        fontSize: 22, 
        fontWeight: 'bold', 
        marginVertical: 16,
        color: '#333',
    },
    feedPlaceholder: {
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        backgroundColor: '#fff',
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#e9ecef',
    },
    feedPlaceholderText: {
        marginTop: 16,
        fontSize: 16,
        color: '#6c757d',
        textAlign: 'center'
    },
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
        backgroundColor: '#e9ecef',
    },
    secondaryButtonText: {
        color: '#495057',
        fontSize: 16,
        fontWeight: '600',
    },
    // Styles for EditableInfoRow within SettingsModal
    infoRow: {
        paddingVertical: 10,
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
    infoInput: {
        flex: 1,
        fontSize: 16,
        borderWidth: 1,
        borderColor: '#ccc',
        borderRadius: 6,
        padding: 8,
        marginRight: 8,
    },
    editContainer: {
        flexDirection: 'row',
        alignItems: 'center',
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

    // --- Photo Edit Modal & Carousel Styles (mostly unchanged) ---
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

    // --- Settings Modal specific styles ---
    modalViewContainer: {
        flex: 1,
        backgroundColor: '#f8f9fa',
    },
    modalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
        backgroundColor: '#fff',
    },
    modalHeaderTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#333',
    },
    closeButton: {
        padding: 5,
    },
    modalScrollView: {
        paddingHorizontal: 16,
    },
    editMealPreferences: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        borderRadius: 8,
    },
    editMealPreferencesText: {
        color: '#007AFF',
        fontSize: 16,
        fontWeight: '500',
        marginLeft: 8,
    },
     infoValue: {
        marginRight: 8,
    },
    editPencilButton: {
        width: 28,
        height: 28,
        borderRadius: 14,
        backgroundColor: '#007AFF',
        justifyContent: 'center',
        alignItems: 'center',
    },
});