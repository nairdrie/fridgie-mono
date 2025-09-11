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
import { SafeAreaProvider } from "react-native-safe-area-context";

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
      <SafeAreaProvider>
        <AuthProvider>
        <ListProvider>
          <RootView>
            <StatusBar style="dark" />
            {/* The Stack component defines the navigator */}
            <Stack>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen
                name="index"
                options={{ 
                  title: 'index',
                  headerShown: false
                }}
              />
              <Stack.Screen
                name="login"
                options={{ 
                  title: 'Login',
                  headerShown: false
                }}
              />
              <Stack.Screen
                name="groups"
                options={{ 
                  title: 'Groups',
                  headerShown: false
                }}
              />
              <Stack.Screen
                name="complete-profile"
                options={{ 
                  title: 'Complete Profile',
                  headerShown: false
                }}
              />
              <Stack.Screen
                name="meal-preferences"
                options={{ 
                  title: 'Meal Preferences',
                  headerShown: false
                }}
              />
              <Stack.Screen
                name="rate-meal"
                options={{ 
                  title: 'Rate Meal',
                  headerShown: false
                }}
              />
              <Stack.Screen
                name="oauthredirect"
                options={{ 
                  headerShown: false
                }}
              />
            </Stack>
          </RootView>
        </ListProvider>
      </AuthProvider>
      </SafeAreaProvider>
  );
}