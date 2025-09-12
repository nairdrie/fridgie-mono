// components/NotificationBell.tsx
import { useAuth } from '@/context/AuthContext';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { getMyNotifications } from '../utils/api';

interface NotificationBellProps {
  onPress: () => void;
  setNotificationCount: (count: number) => void;
}

export default function NotificationBell({ onPress, setNotificationCount }: NotificationBellProps) {
    const { user } = useAuth();
    const [localCount, setLocalCount] = useState(0);

    useFocusEffect(
        useCallback(() => {
            if (!user || user.isAnonymous) return;

            const fetchNotifications = async () => {
                try {
                    const notifications = await getMyNotifications();
                    const count = notifications.length;
                    setLocalCount(count);
                    setNotificationCount(count);
                } catch (error) {
                    console.error("Failed to fetch notifications:", error);
                }
            };
            fetchNotifications();
        }, [user])
    );

    return (
        <TouchableOpacity onPress={onPress} style={styles.container}>
            <Ionicons name="notifications-outline" size={28} color="#000" />
            {localCount > 0 && (
                <View style={styles.badge}>
                    <Text style={styles.badgeText}>{localCount > 9 ? '9+' : localCount}</Text>
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
