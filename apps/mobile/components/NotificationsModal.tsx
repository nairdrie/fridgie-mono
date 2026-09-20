import { AmbientBackground, GlassPressable as TouchableOpacity, GlassSurface, useGlassPreferences } from '@/components/ui/Glass';
// components/NotificationsModal.tsx
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useMemo } from 'react';
import { ActivityIndicator, FlatList, Image, Modal, SafeAreaView, StyleSheet, Text, View } from 'react-native';

interface NotificationsModalProps {
    isVisible: boolean;
    onClose: () => void;
    notifications: any[]; // Replace with a proper Notification type
    isLoading: boolean;
    onAccept: (invitationId: string) => void;
    onDecline: (invitationId: string) => void;
}

export default function NotificationsModal({ isVisible, onClose, notifications, isLoading, onAccept, onDecline }: NotificationsModalProps) {
    const { reduceMotion } = useGlassPreferences();
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
        <Modal visible={isVisible} animationType={reduceMotion ? "none" : "slide"} presentationStyle="pageSheet" onRequestClose={onClose}>
            <AmbientBackground>
            <SafeAreaView style={styles.container}>
                <View style={styles.header}>
                    <View><Text style={styles.eyebrow}>YOUR LITTLE UPDATES</Text><Text style={styles.headerTitle}>Inbox</Text></View>
                    <GlassSurface style={styles.closeGlass}><TouchableOpacity onPress={onClose} style={styles.closeButton} accessibilityLabel="Close notifications"><Ionicons name="close" size={22} color={primary} /></TouchableOpacity></GlassSurface>
                </View>
                {isLoading ? (
                    <View style={styles.emptyView}><ActivityIndicator size="large" /></View>
                ) : (
                    <FlatList
                        data={sortedNotifications}
                        contentContainerStyle={styles.listContent}
                        keyExtractor={(item) => item.id}
                        ListEmptyComponent={<View style={styles.emptyView}><GlassSurface style={styles.emptyIcon}><Ionicons name="notifications-outline" size={34} color={primary} /></GlassSurface><Text style={styles.emptyTitle}>All caught up</Text><Text style={styles.emptySubtitle}>A quiet kitchen is a happy kitchen.
Your updates will appear here.</Text></View>}
                        renderItem={({ item: notif }) => {
                            switch (notif.type) {
                                case 'group_invitation':
                                    return (
                                        <GlassSurface style={styles.notificationItem}>
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
                                        </GlassSurface>
                                    );
                                case 'NEW_FOLLOWER':
                                    return (
                                        <GlassSurface style={styles.notificationItem}>
                                            {notif.senderAvatar ? (
                                                <Image source={{ uri: notif.senderAvatar }} style={styles.avatar} />
                                            ) : (
                                                <Ionicons name="person-circle-outline" size={32} color="#888" style={styles.icon} />
                                            )}
                                            <View style={styles.content}>
                                                <Text style={styles.text}><Text style={{ fontWeight: 'bold' }}>{notif.senderUsername}</Text> started following you.</Text>
                                            </View>
                                        </GlassSurface>
                                    );
                                default:
                                    return null;
                            }
                        }}
                    />
                    )
                }
            </SafeAreaView>
            </AmbientBackground>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: 'transparent' },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 27, paddingBottom: 23 },
    eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4, color: '#78857D', marginBottom: 7 },
    headerTitle: { fontSize: 32, fontWeight: '700', letterSpacing: -1.1, color: '#173F35' },
    closeGlass: { borderRadius: 20 },
    closeButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
    listContent: { flexGrow: 1, paddingHorizontal: 22, paddingBottom: 32 },
    emptyView: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, paddingBottom: 100 },
    emptyIcon: { width: 86, height: 86, borderRadius: 29, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
    emptyTitle: { fontSize: 25, fontWeight: '700', letterSpacing: -0.7, color: '#173F35', marginBottom: 10 },
    emptySubtitle: { fontSize: 14, lineHeight: 22, color: '#78857D', textAlign: 'center' },
    notificationItem: { flexDirection: 'row', alignItems: 'flex-start', padding: 19, borderRadius: 25, marginBottom: 12 },
    icon: { marginRight: 13, marginTop: 2 },
    avatar: { width: 40, height: 40, borderRadius: 16, marginRight: 13 },
    content: { flex: 1 },
    text: { fontSize: 14, lineHeight: 22, color: '#476458' },
    actions: { flexDirection: 'row', marginTop: 16, gap: 8 },
    button: { paddingVertical: 11, paddingHorizontal: 18, borderRadius: 15 },
    acceptButton: { backgroundColor: primary },
    acceptButtonText: { color: '#fff', fontWeight: '600', fontSize: 13 },
    declineButton: { backgroundColor: '#E6EBE4' },
    declineButtonText: { color: '#476458', fontWeight: '600', fontSize: 13 },
});
