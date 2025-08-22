
import { useRouter } from 'expo-router';
import { getAuth, signOut } from 'firebase/auth';
import React, { useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Modal from 'react-native-modal';


export default function UserProfile() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  const auth = getAuth();
  const user = auth.currentUser;

  if (!user) return null;

  const clickedsetVisible = (value: boolean) => {
    if( (!user || user.isAnonymous) && value) {
      router.navigate('/login');
      return;
    }
    setVisible(value);
  };
  return (
    <>
      <Pressable onPress={() => clickedsetVisible(true)} style={styles.avatarWrapper}>
        { user.isAnonymous ? (
          <Text style={{ color: '#888', fontSize: 12, textAlign: 'center' }}>
            Sign in
          </Text>
        ) : <Image
          source={{
            uri: user.photoURL || 'https://placehold.co/40x40',
          }}
          style={styles.avatar}
        />  
        }
        
      </Pressable>

      <Modal
        isVisible={visible}
        onBackdropPress={() => setVisible(false)}
        backdropOpacity={0.4}
      >
        <View style={styles.profileSheet}>
          <Text style={styles.profileEmail}>
            {user.email || user.phoneNumber || 'Anonymous'}
          </Text>
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
  avatarWrapper: {
    
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  profileSheet: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 20,
    alignItems: 'center',
  },
  profileEmail: {
    fontSize: 14,
    marginBottom: 16,
    color: '#333',
  },
  logoutButton: {
    backgroundColor: '#ff3b30',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  logoutText: {
    color: 'white',
    fontWeight: '600',
  },
});
