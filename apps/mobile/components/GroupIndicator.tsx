import { useAuth } from '@/context/AuthContext';
import React, { useEffect } from 'react';
import { Image, StyleSheet, View } from 'react-native';

const ONLINE_THRESHOLD_MS = 60 * 1000; // 1 minute

export default function GroupIndicator() {
    const { selectedGroup, serverTimeOffset } = useAuth();

    useEffect(() => {
        console.log(selectedGroup)
    }, [selectedGroup])
  return (
    <View style={styles.container}>
      {selectedGroup && selectedGroup.members.slice(0, 10).map((member, index) => {
        const key = `${member.uid}-${index}`;
        const zIndex = 100-index;
        const estimatedServerTime = Date.now() + serverTimeOffset;
        const isOnline = member.lastOnline
          ? estimatedServerTime - member.lastOnline < ONLINE_THRESHOLD_MS
          : false;
          
        return (
          <View
            key={key}
            style={[
                styles.photoContainer,
                zIndex,
            ]}
          >
            { member.photoURL &&
              <Image
                source={{ uri: member.photoURL }}
                style={[
                    styles.photo,
                    isOnline ? styles.onlineUser : styles.offlineUser,
                ]}
              />
            }
          </View>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end'
  },
  spacer: {
    height: 30,
  },
  photoContainer: {
  },
  photo: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
  },
  onlineUser: {
    borderColor: '#007222ff'
  },
  offlineUser: {
    borderColor: '#c7c7c7'
  }
});

