import { Group } from '@/types/types';
import { useRouter } from 'expo-router';
import { getAuth } from 'firebase/auth'; // ← assuming Firebase
import React, { useEffect, useState } from 'react';
import {
  Button,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import { createGroup, getGroups } from '../utils/api';


export default function GroupsScreen() {
  const router = useRouter(); 
  const [groups, setGroups] = useState<Group[]>([]);
  const auth = getAuth();

  useEffect(() => {
    getGroups().then(setGroups);
  }, []);

  const handleCreateGroup = async () => {
    const user = auth.currentUser;
    if (!user || user.isAnonymous) {
      // if there’s no real user, send them to Login (or modal) first
      router.push('/login' /* make sure this route exists */);
      return;
    }

    // otherwise, proceed with creation
    try {
      const newGroup = await createGroup('New Group');
      setGroups((prev) => [...prev, newGroup]);
    } catch (err) {
      console.error('failed to create group', err);
      // you might show a toast or alert here
    }
  };

  return (
    <View style={styles.container}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  item: { padding: 12, borderBottomWidth: 1, borderColor: '#eee' },
  text: { fontSize: 16 },
});
