import { useRouter } from 'expo-router';
import React, { useEffect } from 'react';
import {
  ActivityIndicator
} from 'react-native';

// --- MAIN SCREEN COMPONENT ---
export default function OauthRedirect() {

  const router = useRouter();

  useEffect(() => {
    router.push('/login');
  }, []);

  return (
    <ActivityIndicator></ActivityIndicator>
  );
}