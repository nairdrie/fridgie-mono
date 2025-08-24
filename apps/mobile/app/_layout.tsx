// app/_layout.tsx
import "@/utils/firebase";
import { Stack } from 'expo-router';
import React from 'react';
import { Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

// Import your components
import { AuthProvider } from "@/context/AuthContext";
import { ListProvider } from '@/context/ListContext';
import ListHeader from '../components/ListHeader';
import UserProfile from '../components/UserProfile';

// Create a wrapper component that conditionally applies GestureHandlerRootView
const RootView = ({ children }: { children: React.ReactNode }) => {
  if (Platform.OS === 'web') {
    // On web, a standard View is sufficient.
    return <View style={{ flex: 1 }}>{children}</View>;
  }
  // On mobile, the GestureHandler is required for proper touch handling.
  return <GestureHandlerRootView style={{ flex: 1 }}>{children}</GestureHandlerRootView>;
};

export default function RootLayout() {
  return (
    <AuthProvider>
      <ListProvider>
        <RootView>
          {/* The Stack component defines the navigator */}
          <Stack initialRouteName="groups">
            <Stack.Screen
              name="groups" // This matches the file name: groups.tsx
              options={{
                title: 'Your Groups',
                headerRight: () => (
                  <View style={{ paddingRight: 12 }}>
                    <UserProfile />
                  </View>
                ),
              }}
            />
            <Stack.Screen
              name="list" // This matches the file name: list.tsx
              options={{
                headerShown: true,
                headerTitle: () => <ListHeader />,
                headerRight: () => (
                  <View style={{ paddingRight: 12 }}>
                    <UserProfile />
                  </View>
                ),
              }}
            />
            <Stack.Screen
              name="login" // This matches the file name: login.tsx
              options={{ title: 'Login' }}
            />
          </Stack>
        </RootView>
      </ListProvider>
    </AuthProvider>
  
  );
}