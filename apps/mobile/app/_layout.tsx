// app/_layout.tsx
import "@/utils/firebase";
import { Stack } from 'expo-router';
import React from 'react';
import { Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

// Import your components
import { AuthProvider } from "@/context/AuthContext";
import { ListProvider } from '@/context/ListContext';
import { StatusBar } from 'expo-status-bar';

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
          <StatusBar style="dark" />
          {/* The Stack component defines the navigator */}
          <Stack>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen
              name="login"
              options={{ title: 'Login' }}
            />
          </Stack>
        </RootView>
      </ListProvider>
    </AuthProvider>
  );
}