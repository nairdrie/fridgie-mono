import React from 'react';
import ConnectionError from '@/components/ConnectionError';
import ListHeader from '@/components/ListHeader';
import { useAuth } from '@/context/AuthContext';
import { useLists } from '@/context/ListContext';
import { useNotifications } from '@/context/NotificationContext';
import { primary } from '@/utils/styles';
import IonIcons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { Image, StyleSheet } from 'react-native';


export default function TabLayout() {
    // const { profile, loading, user } = useAuth();
    const { loading, user, groups, groupsError, refreshGroups } = useAuth();
    const { selectedList, loadError, refreshLists } = useLists();
    const { notificationCount } = useNotifications(); // 2. Get the count from the context
    const [retrying, setRetrying] = React.useState(false);

    // One place decides the app is unreachable, above BOTH the navigator's
    // header and the screen bodies — so they cannot disagree and show a broken
    // header over a convincing empty list.
    //
    // The condition is "we have nothing to show AND something failed", not
    // merely "something failed": a transient error while the week is already on
    // screen should not blow away what the user is looking at.
    const unreachable = (groupsError && groups.length === 0) || (loadError && !selectedList);

    React.useEffect(() => {
      if (!unreachable) setRetrying(false);
    }, [unreachable]);

    if (unreachable) {
      return (
        <ConnectionError
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            if (groupsError) refreshGroups();
            refreshLists();
          }}
        />
      );
    }

  return (
    <Tabs screenOptions={{ 
        tabBarActiveTintColor: primary,
        tabBarStyle: {
          height: 80, // Adjust this value to your desired height
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          paddingBottom: 50
        }
        }}>
        <Tabs.Screen
            name="list" // This matches the file name: list.tsx
            options={{
                headerShown: true,
                header: () => <ListHeader />,
                title: 'Plan',
                tabBarIcon: ({ color }) => (
                    <IonIcons size={28} name="list" color={color} />
                ),
                tabBarShowLabel: false
            }}
        />
        <Tabs.Screen
            name="explore"
            options={{
                title: 'Explore',
                headerShown: false,
                tabBarIcon: ({ color }) => (
                    <IonIcons size={28} name="search" color={color} />
                ),
                tabBarShowLabel: false
            }}
        />
        <Tabs.Screen
            name="profile"
            options={{
                title: 'Profile',
                headerShown: false,
                tabBarBadge: notificationCount > 0 ? notificationCount : undefined,
                tabBarBadgeStyle: { backgroundColor: primary },
                tabBarIcon: ({ color, focused }) => {
                    // Use 'tabBarIcon' instead of 'tab'
                    if (user?.photoURL) {
                        return (
                                <Image
                                    source={{ uri: user.photoURL }}
                                    style={[
                                        styles.profileImage,
                                        // 3. When focused is true, apply this border style
                                        focused && {
                                        borderColor: color, // Uses the active tint color
                                        borderWidth: 2,
                                        },
                                    ]}
                                />
                        );
                    } else {
                        return (
                            <IonIcons size={28} name="person" color={color} />
                        )
                    }
                },
                tabBarShowLabel: false,
            }}
            listeners={({ navigation }) => ({
                tabPress: (e) => {
                    // Prevent the default action
                    e.preventDefault();
                    
                    // Navigate to the root of the profile tab, without any params
                    navigation.navigate('profile', { uid: undefined });
                },
            })}
        />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  profileImage: {
    width: 36,
    height: 36,
    borderRadius: 36,
    boxShadow: '0 1px 8px rgba(0, 0, 0, 0.1)',
  },
  tabIconContainer: {
    flex: 1, // This makes the View take up all available space
    justifyContent: 'center', // Vertically center the icon
    alignItems: 'center',     // Horizontally center the icon
  }
});
 
