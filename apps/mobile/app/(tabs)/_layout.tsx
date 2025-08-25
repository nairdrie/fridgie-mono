import ListHeader from '@/components/ListHeader';
import IonIcons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';


export default function TabLayout() {
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: '#007AFF' }}>
        <Tabs.Screen
            name="list" // This matches the file name: list.tsx
            options={{
                headerShown: true,
                header: () => <ListHeader />,
                title: 'Plan',
                tabBarIcon: ({ color }) => (
                    <IonIcons size={28} name="list" color={color} />
                ),
            }}
        />
        <Tabs.Screen
            name="explore"
            options={{
                title: 'Explore',
                tabBarIcon: ({ color }) => (
                    <IonIcons size={28} name="search" color={color} />
                ),
            }}
        />
        <Tabs.Screen
            name="profile"
            options={{
                title: 'Profile',
                tabBarIcon: ({ color }) => (
                    <IonIcons size={28} name="person" color={color} />
                ),
            }}
        />
    </Tabs>
  );
}
