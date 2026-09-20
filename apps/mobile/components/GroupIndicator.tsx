import { useAuth } from '@/context/AuthContext';
import { defaultAvatars } from '@/utils/defaultAvatars';
import { canvas, ink, inkMuted, primary } from '@/utils/styles';
import { GlassPressable as TouchableOpacity, GlassSurface } from './ui/Glass';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { FlatList, Image, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import Modal from 'react-native-modal';

// A client-side staleness threshold used to live here but was never wired up.
// It isn't needed: presence is torn down by an RTDB onDisconnect handler, which
// the *server* fires when the socket drops, so a stale `online: true` resolves
// itself without the client second-guessing it. A local TTL would only add
// flicker on slow networks.

export default function GroupIndicator() {
    const { selectedGroup, user } = useAuth();
    const [isModalVisible, setModalVisible] = useState(false);
    const router = useRouter();

    const handleSwitchGroup = () => {
        setModalVisible(false);
        router.push('/groups');
    };

    if (!selectedGroup) {
        return <View style={styles.container} />; // Return empty container to maintain layout
    }

    // Sort members to show the current user first, then alphabetically
    const sortedMembers = [...selectedGroup.members].sort((a, b) => {
        if (a.uid === user?.uid) return -1;
        if (b.uid === user?.uid) return 1;
        return (a.displayName || '').localeCompare(b.displayName || '');
    });

    return (
        <>
            <TouchableOpacity accessibilityLabel={`View ${selectedGroup.name} members`} style={styles.container} onPress={() => setModalVisible(true)}>
                {sortedMembers.slice(0, 3).map((member, index) => (
                    <Image
                        key={member.uid}
                        source={{ uri: member.photoURL || defaultAvatars[0] }}
                        style={[styles.photo, member.online ? styles.onlinePhoto: styles.offlinePhoto, { marginLeft: index > 0 ? -12 : 0, zIndex: 100 - index }]}
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
                <GlassSurface intensity={80} style={styles.sheet}><SafeAreaView>
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
                            return (
                                <View style={styles.memberItem}>
                                    <Image source={{ uri: member.photoURL || defaultAvatars[0] }} style={styles.memberAvatar} />
                                    <View style={styles.memberInfo}>
                                        <Text style={styles.memberName}>{member.displayName} {member.uid === user?.uid && '(You)'}</Text>
                                        <View style={styles.statusContainer}>
                                            <View style={[styles.statusDot, member.online ? styles.onlineDot : styles.offlineDot]} />
                                            <Text style={[styles.statusText, member.online ? styles.onlineText : styles.offlineText]}>
                                                {member.online ? 'Online' : 'Offline'}
                                            </Text>
                                        </View>
                                    </View>
                                </View>
                            );
                        }}
                    />

                    <View style={styles.modalFooter}>
                         <TouchableOpacity style={styles.secondaryButton} onPress={handleSwitchGroup}>
                            <Ionicons name="people-outline" size={20} color={primary} />
                            <Text style={styles.secondaryButtonText}>Switch or Manage Groups</Text>
                        </TouchableOpacity>
                    </View>
                </SafeAreaView></GlassSurface>
            </Modal>
        </>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        height: 40,
    },
    photo: {
        width: 35,
        height: 35,
        borderRadius: 25,
        borderWidth: 2,
        borderColor: '#fff',
    },
    onlinePhoto: {
        borderColor: '#FFFFFF',
    },
    offlinePhoto: {
        borderColor: '#FFFFFF',
        opacity: 0.72,
    },
    modal: {
        justifyContent: 'flex-end',
        margin: 0,
    },
    sheet: {
        backgroundColor: canvas,
        borderTopLeftRadius: 32,
        borderTopRightRadius: 32,
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
        fontWeight: '700',
        color: ink,
        letterSpacing: -0.6,
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
        borderRadius: 20,
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
        backgroundColor: primary, // Green
    },
    offlineDot: {
        backgroundColor: '#8e8e93', // Gray
    },
    statusText: {
        fontSize: 14,
        color: inkMuted,
    },
    onlineText: {
        color: primary,
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
        backgroundColor: 'rgba(220,237,226,0.7)',
        borderColor: '#fff',
        borderWidth: 1,
        paddingVertical: 12,
        borderRadius: 25,
    },
    secondaryButtonText: {
        color: primary,
        fontSize: 16,
        fontWeight: '600',
        marginLeft: 8,
    },
});