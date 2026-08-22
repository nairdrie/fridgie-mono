// app/_layout.tsx
import "@/utils/firebase";
import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router';
import React, { useEffect, useRef } from 'react';
import { Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

// Import your components
import { AuthProvider } from "@/context/AuthContext";
import { ListProvider } from '@/context/ListContext';
import { NotificationProvider } from "@/context/NotificationContext";
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from "react-native-safe-area-context";

// Without a handler, a notification that arrives while the app is open is
// swallowed silently — the OS assumes a foregrounded app will present it itself.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/**
 * Routes a tapped meal-rating reminder to the rating screen.
 *
 * useLastNotificationResponse covers the cold-start case too — if the tap
 * launched the app, the response is already waiting on first render, which a
 * plain listener subscription would miss. It keeps returning the same response
 * across re-renders, hence the guard.
 */
function MealRatingNotificationRouter() {
  const router = useRouter();
  const response = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!response) return;

    const request = response.notification.request;
    if (handled.current === request.identifier) return;

    const data = request.content.data as { type?: string; recipeId?: string; mealId?: string };
    if (data?.type !== 'meal-rating' || !data.recipeId) return;

    handled.current = request.identifier;
    router.push({
      pathname: '/rate-meal',
      params: { recipeId: data.recipeId, ...(data.mealId ? { mealId: data.mealId } : {}) },
    });
  }, [response, router]);

  return null;
}

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
          <NotificationProvider>
            <ListProvider>
              <RootView>
                <StatusBar style="dark" />
                <MealRatingNotificationRouter />
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
                      headerShown: false,
                      // Same shape as profile/[uid] below, same reason.
                      fullScreenGestureEnabled: true
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
                  <Stack.Screen
                      name="profile/[uid]"
                      options={{
                        title: 'Profile',
                        headerShown: false,
                        // These screens hide the navigator's header for one of
                        // their own, so the back chevron is the only thing that
                        // says you can leave — and iOS's pop gesture, the way it
                        // comes, only fires from the ~20pt left edge. Someone
                        // holding the phone one-handed swipes across the middle
                        // of a full-bleed screen and nothing happens. Recognise
                        // the drag anywhere instead. Safe here because neither
                        // screen has anything horizontally swipeable in it to
                        // take the gesture from — a carousel or a swipe-to-delete
                        // row would fight it, which is why this is per-screen
                        // rather than a default on the whole stack. iOS-only;
                        // Android's system back gesture already works from
                        // either edge.
                        fullScreenGestureEnabled: true
                      }}
                  />
                </Stack>
              </RootView>
            </ListProvider>
          </NotificationProvider>
        </AuthProvider>
      </SafeAreaProvider>
  );
}