import ListHeader from '@/components/ListHeader';
import { useAuth } from '@/context/AuthContext';
import { primary } from '@/utils/styles';
import IonIcons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { Image, StyleSheet } from 'react-native';


export default function TabLayout() {
    // const { profile, loading, user } = useAuth();
    const { loading, user } = useAuth();
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
                href: !user || user.isAnonymous ? '/login' : '/profile',
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
                tabBarShowLabel: false
            }}
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
 
