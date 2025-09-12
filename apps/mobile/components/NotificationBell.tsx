// components/NotificationBell.tsx
import { useNotifications } from '@/context/NotificationContext';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface NotificationBellProps {
  onPress: () => void;
}

export default function NotificationBell({ onPress }: NotificationBellProps) {
    const { notificationCount } = useNotifications();

    return (
        <TouchableOpacity onPress={onPress} style={styles.container}>
            <Ionicons name="notifications-outline" size={28} color="#000" />
            {notificationCount > 0 && (
                <View style={styles.badge}>
                    <Text style={styles.badgeText}>{notificationCount > 9 ? '9+' : notificationCount}</Text>
                </View>
            )}
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    container: { padding: 5 },
    badge: { position: 'absolute', top: 0, right: 0, backgroundColor: primary, borderRadius: 10, width: 20, height: 20, justifyContent: 'center', alignItems: 'center' },
    badgeText: { color: 'white', fontSize: 12, fontWeight: 'bold' },
});
