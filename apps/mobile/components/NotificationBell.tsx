import { GlassPressable, GlassSurface } from '@/components/ui/Glass';
import { useNotifications } from '@/context/NotificationContext';
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

interface NotificationBellProps {
  onPress: () => void;
}

export default function NotificationBell({ onPress }: NotificationBellProps) {
  const { notificationCount } = useNotifications();
  const label = notificationCount > 0
    ? `Notifications, ${notificationCount} unread ${notificationCount === 1 ? 'update' : 'updates'}`
    : 'Notifications, all caught up';

  return (
    <GlassSurface style={styles.glass}>
      <GlassPressable onPress={onPress} style={styles.container} accessibilityLabel={label}>
        <Ionicons name="notifications-outline" size={22} color="#173F35" />
        {notificationCount > 0 && (
          <View style={styles.badge} accessible={false}>
            <Text style={styles.badgeText}>{notificationCount > 9 ? '9+' : notificationCount}</Text>
          </View>
        )}
      </GlassPressable>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  glass: { borderRadius: 23 },
  container: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: 1, right: 0, backgroundColor: '#D88871', borderRadius: 10, minWidth: 18, height: 18, paddingHorizontal: 4, borderWidth: 2, borderColor: '#F5F5EF', justifyContent: 'center', alignItems: 'center' },
  badgeText: { color: '#FFFFFF', fontSize: 9, fontWeight: '700', lineHeight: 11 },
});
