// app/index.tsx

import { useProtectedRoute } from '@/context/AuthContext';
import { AmbientBackground, GlassSurface } from '@/components/ui/Glass';
import { ink, inkMuted, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { ActivityIndicator, Text } from 'react-native';

export default function Index() {
    // This custom hook will handle the redirect logic.
    useProtectedRoute();

    // Render a loading indicator while the redirect is processed.
    return (
        <AmbientBackground style={{ justifyContent: 'center', alignItems: 'center', gap: 18 }}>
            <GlassSurface style={{ width: 82, height: 82, borderRadius: 28, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="leaf" size={42} color={primary} /></GlassSurface>
            <Text style={{ color: ink, fontSize: 40, fontWeight: '800', letterSpacing: -2 }}>fridgie.</Text>
            <Text style={{ color: inkMuted, fontSize: 15, marginBottom: 18 }}>A little more delicious.</Text>
            <ActivityIndicator color={primary} accessibilityLabel="Opening your kitchen" />
        </AmbientBackground>
    );
}
