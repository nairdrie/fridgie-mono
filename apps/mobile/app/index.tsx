// app/index.tsx

import { useProtectedRoute } from '@/context/AuthContext';
import React from 'react';
import { ActivityIndicator, View } from 'react-native';

export default function Index() {
    // This custom hook will handle the redirect logic.
    useProtectedRoute();

    // Render a loading indicator while the redirect is processed.
    return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator size="large" />
        </View>
    );
}