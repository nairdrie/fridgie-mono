// components/NotificationsModal.tsx
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useMemo } from 'react';
import { ActivityIndicator, FlatList, Image, Modal, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface NotificationsModalProps {
    isVisible: boolean;
    onClose: () => void;
    notifications: any[]; // Replace with a proper Notification type
    isLoading: boolean;
    onAccept: (invitationId: string) => void;
    onDecline: (invitationId: string) => void;
}

export default function NotificationsModal({ isVisible, onClose, notifications, isLoading, onAccept, onDecline }: NotificationsModalProps) {
    const sortedNotifications = useMemo(() => {
        if (!notifications) return [];
        // The 'createdAt' field might be a Firestore Timestamp object.
        // We need to handle both object and number cases for sorting.
        return [...notifications].sort((a, b) => {
            const timeA = a.createdAt?.seconds ? a.createdAt.toMillis() : (a.createdAt || 0);
            const timeB = b.createdAt?.seconds ? b.createdAt.toMillis() : (b.createdAt || 0);
            return timeB - timeA; // Sort descending (newest first)
        });
    }, [notifications]);

    return (
        <Modal visible={isVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
            <SafeAreaView style={styles.container}>
                <View style={styles.header}>
                    <Text style={styles.headerTitle}>Notifications</Text>
                    <TouchableOpacity onPress={onClose}><Ionicons name="close" size={28} color={primary} /></TouchableOpacity>
                </View>
                {isLoading ? (
                    <View style={styles.emptyView}><ActivityIndicator size="large" /></View>
                ) : (
                    <FlatList
                        data={sortedNotifications}
                        keyExtractor={(item) => item.id}
                        ListEmptyComponent={<View style={styles.emptyView}><Text>No new notifications.</Text></View>}
                        renderItem={({ item: notif }) => {
                            switch (notif.type) {
                                case 'group_invitation':
                                    return (
                                        <View style={styles.notificationItem}>
                                            <Ionicons name="people-outline" size={24} color="#888" style={styles.icon} />
                                            <View style={styles.content}>
                                                <Text style={styles.text}><Text style={{ fontWeight: 'bold' }}>{notif.data.inviterName}</Text> invited you to join <Text style={{ fontWeight: 'bold' }}>{notif.data.groupName}</Text>.</Text>
                                                <View style={styles.actions}>
                                                    <TouchableOpacity style={[styles.button, styles.acceptButton]} onPress={() => onAccept(notif.data.invitationId)}>
                                                        <Text style={styles.acceptButtonText}>Accept</Text>
                                                    </TouchableOpacity>
                                                    <TouchableOpacity style={[styles.button, styles.declineButton]} onPress={() => onDecline(notif.data.invitationId)}>
                                                        <Text style={styles.declineButtonText}>Decline</Text>
                                                    </TouchableOpacity>
                                                </View>
                                            </View>
                                        </View>
                                    );
                                case 'NEW_FOLLOWER':
                                    return (
                                        <View style={styles.notificationItem}>
                                            {notif.senderAvatar ? (
                                                <Image source={{ uri: notif.senderAvatar }} style={styles.avatar} />
                                            ) : (
                                                <Ionicons name="person-circle-outline" size={32} color="#888" style={styles.icon} />
                                            )}
                                            <View style={styles.content}>
                                                <Text style={styles.text}><Text style={{ fontWeight: 'bold' }}>{notif.senderUsername}</Text> started following you.</Text>
                                            </View>
                                        </View>
                                    );
                                default:
                                    return null;
                            }
                        }}
                    />
                    )
                }
            </SafeAreaView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    headerTitle: {
        fontSize: 20,
        fontWeight: 'bold',
    },
    emptyView: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    notificationItem: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    icon: {
        marginRight: 12,
        marginTop: 2,
    },
    avatar: {
        width: 32,
        height: 32,
        borderRadius: 16,
        marginRight: 12,
    },
    content: {
        flex: 1,
    },
    text: {
        fontSize: 16,
    },
    actions: {
        flexDirection: 'row',
        marginTop: 12,
    },
    button: {
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 5,
        marginHorizontal: 5,
    },
    acceptButton: {
        backgroundColor: primary,
    },
    acceptButtonText: {
        color: '#fff',
        fontWeight: 'bold',
    },
    declineButton: {
        backgroundColor: '#f0f0f0',
    },
    declineButtonText: {
        color: '#000',
        fontWeight: 'bold',
    },
});
