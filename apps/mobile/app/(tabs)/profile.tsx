import { useAuth } from '@/context/AuthContext';
import { Group } from '@/types/types';
import { createGroup } from '@/utils/api';
import { auth } from '@/utils/firebase';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import React from 'react';
import {
  Button,
  FlatList,
  Image,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';


export default function UserProfile() {
  const router = useRouter(); 
  // const { profile, loading, groups, selectGroup } = useAuth(); 
  const { loading, groups, selectGroup, user } = useAuth(); 


  const handleCreateGroup = async () => {
    const user = auth.currentUser;
    if (!user || user.isAnonymous) {
      router.push('/login');
      return;
    }

    try {
      const newGroup = await createGroup('New Group');
      // The `onAuthStateChanged` listener will handle refetching the groups,
      // but for immediate feedback you might want to optimistically update the state.
      // A full solution would add the new group to your `AuthContext` state.
    } catch (err) {
      console.error('failed to create group', err);
    }
  };

  const navigateToList = (group: Group) => {
    selectGroup(group); // ⬅️ Set the selected group in state
    router.push('/list'); // ⬅️ Navigate to the list screen without passing a param
  };


  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.profileContainer}>
        {user?.photoURL && (
          <Image
            source={{ uri: user.photoURL }}
            style={styles.profileImage}
          />
        )}
        <Text style={styles.profileText}>Phone: {user?.phoneNumber}</Text>
      </View>
      <FlatList
        data={groups}
        keyExtractor={g => g.id}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.item}
            onPress={() =>
              router.push({pathname: '/list', params: { 
                groupId: item.id
            }})
            }
          >
            <Text style={styles.text}>{item.name}</Text>
          </TouchableOpacity>
        )}
      />

      <Button
        title="Create Group"
        onPress={handleCreateGroup}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    padding: 16,
    marginTop: Constants.statusBarHeight,

  },
  profileContainer: {
    alignItems: 'center',
    marginBottom: 24,
    padding: 16,
    backgroundColor: '#fff',
    borderRadius: 12,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 5,
  },
  profileImage: {
    width: 80,
    height: 80,
    borderRadius: 40,
    marginBottom: 12,
  },
  profileText: {
    fontSize: 18,
    fontWeight: '500',
    color: '#333',
  },
  item: { padding: 12, borderBottomWidth: 1, borderColor: '#eee' },
  text: { fontSize: 16 },
});
