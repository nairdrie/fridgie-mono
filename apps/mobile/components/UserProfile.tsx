// TODO depricate
import { auth } from '@/utils/firebase';
import { useRouter } from 'expo-router';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Modal from 'react-native-modal';

export default function UserProfile() {
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return unsub;
  }, []);

  // While auth is initializing you can render a tiny placeholder (optional)
  if (user === null) {
    return (
      <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
        {/* placeholder or spinner if you want */}
      </View>
    );
  }

  const clickedsetVisible = (value: boolean) => {
    if ((!user || user.isAnonymous) && value) {
      router.navigate('/login');
      return;
    }
    setVisible(value);
  };

  return (
    <>
      <Pressable onPress={() => clickedsetVisible(true)} style={styles.avatarWrapper}>
        {user.isAnonymous ? (
          <Text style={{ color: '#888', fontSize: 12, textAlign: 'center' }}>Sign in</Text>
        ) : (
          <Image
            source={{ uri: user.photoURL || 'https://placehold.co/40x40' }}
            style={styles.avatar}
          />
        )}
      </Pressable>

      <Modal isVisible={visible} onBackdropPress={() => setVisible(false)} backdropOpacity={0.4}>
        <View style={styles.profileSheet}>
          <Text style={styles.profileEmail}>{user.email || user.phoneNumber || 'Anonymous'}</Text>
          <TouchableOpacity
            onPress={async () => {
              await signOut(auth);
              setVisible(false);
            }}
            style={styles.logoutButton}
          >
            <Text style={styles.logoutText}>Log out</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  avatarWrapper: {},
  avatar: { width: 36, height: 36, borderRadius: 18 },
  profileSheet: { backgroundColor: '#fff', borderRadius: 10, padding: 20, alignItems: 'center' },
  profileEmail: { fontSize: 14, marginBottom: 16, color: '#333' },
  logoutButton: { backgroundColor: '#ff3b30', paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8 },
  logoutText: { color: 'white', fontWeight: '600' },
});
