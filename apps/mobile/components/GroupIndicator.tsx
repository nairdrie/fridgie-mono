import { useAuth } from '@/context/AuthContext';
import { defaultAvatars } from '@/utils/defaultAvatars';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { FlatList, Image, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Modal from 'react-native-modal';

const ONLINE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

export default function GroupIndicator() {
    const { selectedGroup, serverTimeOffset, user } = useAuth();
    const [isModalVisible, setModalVisible] = useState(false);
    const router = useRouter();

    const handleSwitchGroup = () => {
        setModalVisible(false);
        router.push('/groups');
    };

    if (!selectedGroup) {
        return <View style={styles.container} />; // Return empty container to maintain layout
    }

    const members = selectedGroup.members.map(member=> {
      const estimatedServerTime = Date.now() + serverTimeOffset;
      const isOnline = member.lastOnline ? estimatedServerTime - new Date(member.lastOnline).getTime() < ONLINE_THRESHOLD_MS : false;
      return {
        ...member,
        isOnline,
      };
    })

    // Sort members to show the current user first, then alphabetically
    const sortedMembers = members.sort((a, b) => {
        if (a.uid === user?.uid) return -1;
        if (b.uid === user?.uid) return 1;
        return (a.displayName || '').localeCompare(b.displayName || '');
    });

    return (
        <>
            <TouchableOpacity style={styles.container} onPress={() => setModalVisible(true)}>
                {members.slice(0, 5).map((member, index) => (
                    <Image
                        key={member.uid}
                        source={{ uri: member.photoURL || defaultAvatars[0] }}
                        style={[styles.photo, member.isOnline ? styles.onlinePhoto: styles.offlinePhoto, { marginLeft: index > 0 ? -16 : 0, zIndex: 100 - index }]}
                    />
                ))}
            </TouchableOpacity>

            <Modal
                isVisible={isModalVisible}
                onBackdropPress={() => setModalVisible(false)}
                onBackButtonPress={() => setModalVisible(false)}
                swipeDirection="down"
                onSwipeComplete={() => setModalVisible(false)}
                style={styles.modal}
            >
                <SafeAreaView style={styles.sheet}>
                    {/* Grabber Handle */}
                    <View style={styles.grabberContainer}>
                        <View style={styles.grabber} />
                    </View>

                    <Text style={styles.sheetTitle}>{selectedGroup.name}</Text>
                    
                    <FlatList
                        data={sortedMembers}
                        keyExtractor={(item) => item.uid}
                        contentContainerStyle={styles.listContentContainer}
                        renderItem={({ item: member }) => {
                            const estimatedServerTime = Date.now() + serverTimeOffset;
                            const isOnline = member.lastOnline
                                ? estimatedServerTime - new Date(member.lastOnline).getTime() < ONLINE_THRESHOLD_MS
                                : false;

                            return (
                                <View style={styles.memberItem}>
                                    <Image source={{ uri: member.photoURL || defaultAvatars[0] }} style={styles.memberAvatar} />
                                    <View style={styles.memberInfo}>
                                        <Text style={styles.memberName}>{member.displayName} {member.uid === user?.uid && '(You)'}</Text>
                                        <View style={styles.statusContainer}>
                                            <View style={[styles.statusDot, isOnline ? styles.onlineDot : styles.offlineDot]} />
                                            <Text style={[styles.statusText, isOnline ? styles.onlineText : styles.offlineText]}>
                                                {isOnline ? 'Online' : 'Offline'}
                                            </Text>
                                        </View>
                                    </View>
                                </View>
                            );
                        }}
                    />

                    <View style={styles.modalFooter}>
                         <TouchableOpacity style={styles.secondaryButton} onPress={handleSwitchGroup}>
                            <Ionicons name="people-outline" size={20} color="#007AFF" />
                            <Text style={styles.secondaryButtonText}>Switch or Manage Groups</Text>
                        </TouchableOpacity>
                    </View>
                </SafeAreaView>
            </Modal>
        </>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        height: 40, // Set fixed height
    },
    photo: {
        width: 40,
        height: 40,
        borderRadius: 20,
        borderWidth: 2,
        borderColor: '#fff',
    },
    onlinePhoto: {
        borderColor: '#038523ff', // Green
    },
    offlinePhoto: {
        borderColor: '#c0c0c0ff', // Gray
        filter: 'grayscale(60%)',
    },
    modal: {
        justifyContent: 'flex-end',
        margin: 0,
    },
    sheet: {
        backgroundColor: '#f8f9fa',
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        maxHeight: '70%',
    },
    grabberContainer: {
        alignItems: 'center',
        paddingTop: 12,
    },
    grabber: {
        width: 40,
        height: 4,
        borderRadius: 2,
        backgroundColor: '#d0d0d0',
    },
    sheetTitle: {
        fontSize: 22,
        fontWeight: 'bold',
        textAlign: 'center',
        marginVertical: 16,
    },
    listContentContainer: {
        paddingHorizontal: 16,
    },
    memberItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#fff',
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
    },
    memberAvatar: {
        width: 44,
        height: 44,
        borderRadius: 22,
        marginRight: 12,
    },
    memberInfo: {
        flex: 1,
    },
    memberName: {
        fontSize: 16,
        fontWeight: '600',
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 4,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: 6,
    },
    onlineDot: {
        backgroundColor: '#34c759', // Green
    },
    offlineDot: {
        backgroundColor: '#8e8e93', // Gray
    },
    statusText: {
        fontSize: 14,
    },
    onlineText: {
        color: '#34c759',
    },
    offlineText: {
        color: '#8e8e93',
    },
    modalFooter: {
        padding: 16,
        borderTopWidth: 1,
        borderTopColor: '#e0e0e0',
    },
    secondaryButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'transparent',
        borderColor: '#007AFF',
        borderWidth: 1,
        paddingVertical: 12,
        borderRadius: 25,
    },
    secondaryButtonText: {
        color: '#007AFF',
        fontSize: 16,
        fontWeight: '600',
        marginLeft: 8,
    },
});