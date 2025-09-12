// components/NotificationsModal.tsx
import { GroupInvitation } from '@/utils/api'; // Assuming you have this type in api.ts
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { ActivityIndicator, Modal, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface NotificationsModalProps {
    isVisible: boolean;
    onClose: () => void;
    notifications: any[]; // Replace with a proper Notification type
    isLoading: boolean;
    onAccept: (invitationId: string) => void;
    onDecline: (invitationId: string) => void;
}

export default function NotificationsModal({ isVisible, onClose, notifications, isLoading, onAccept, onDecline }: NotificationsModalProps) {
    return (
        <Modal visible={isVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
            <SafeAreaView style={styles.container}>
                <View style={styles.header}>
                    <Text style={styles.headerTitle}>Notifications</Text>
                    <TouchableOpacity onPress={onClose}><Ionicons name="close" size={28} color={primary} /></TouchableOpacity>
                </View>
                {isLoading ? <ActivityIndicator/> :
                    notifications.length === 0 ? (
                        <View style={styles.emptyView}><Text>No new notifications.</Text></View>
                    ) : (
                        notifications.map(notif => {
                            // This part will need to be expanded for different notification types
                            if (notif.type === 'group_invitation') {
                                return (
                                    <View key={notif.id} style={styles.notificationItem}>
                                        <Text><Text style={{fontWeight: 'bold'}}>{notif.inviterName}</Text> invited you to join <Text style={{fontWeight: 'bold'}}>{notif.groupName}</Text>.</Text>
                                        <View style={styles.actions}>
                                            <TouchableOpacity style={[styles.button, styles.acceptButton]} onPress={() => onAccept(notif.id)}>
                                                <Text style={styles.acceptButtonText}>Accept</Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity style={[styles.button, styles.declineButton]} onPress={() => onDecline(notif.id)}>
                                                <Text style={styles.declineButtonText}>Decline</Text>
                                            </TouchableOpacity>
                                        </View>
                                    </View>
                                )
                            }
                            // Add other notification types here (e.g., likes, follows)
                            return null;
                        })
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
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    actions: {
        flexDirection: 'row',
        marginTop: 10,
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
