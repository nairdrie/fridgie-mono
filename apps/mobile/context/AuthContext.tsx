// context/AuthContext.tsx
import { Group, UserProfile } from '@/types/types';
import { getGroups, loginWithToken, registerForPushNotificationsAsync } from '@/utils/api';
import { defaultAvatars } from '@/utils/defaultAvatars';
import { auth, db } from '@/utils/firebase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, useSegments } from 'expo-router';
import { onAuthStateChanged, signInAnonymously, updateProfile, User } from 'firebase/auth';
import { onDisconnect, onValue, ref, serverTimestamp, set } from 'firebase/database'; // ⬅️ Add serverTimestamp
import React, { createContext, useContext, useEffect, useState } from 'react';

interface UserProfileWithPresence extends UserProfile {
  online?: boolean;
  lastOnline?: number;
}

export interface GroupWithPresence extends Omit<Group, 'members'> {
  members: UserProfileWithPresence[];
}


interface AuthContextType {
  user: User | null;
  // profile: UserProfile | null;
  groups: GroupWithPresence[];
  selectedGroup: GroupWithPresence | null;
  selectGroup: (group: Group) => void; 
  loading: boolean;
  serverTimeOffset: number;
  refreshAuthUser: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  // profile: null,
  groups: [],
  selectedGroup: null,
  selectGroup: () => {},
  loading: true,
  serverTimeOffset: 0, // Add initial value
  refreshAuthUser: () => {}
});

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  // const [profile, setProfile] = useState<UserProfile | null>(null);
  const [groups, setGroups] = useState<GroupWithPresence[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<GroupWithPresence | null>(null);
  const [loading, setLoading] = useState(true);
  const [serverTimeOffset, setServerTimeOffset] = useState(0);
  const [storedGroupId, setStoredGroupId] = useState<string | null | undefined>(undefined);


  const router = useRouter();

  // Main Auth State Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (authUser) => {
      setUser(authUser);

      if (authUser) {
        registerForPushNotificationsAsync();
        if(authUser.isAnonymous && !authUser.photoURL) {
          const randomPhotoURL = defaultAvatars[Math.floor(Math.random() * defaultAvatars.length)];
          await updateProfile(authUser, {
              photoURL: randomPhotoURL
            });
        }
        if(!authUser.isAnonymous && !authUser.displayName) {
          console.log("COMPLETE PROFILE FROM AUTH")
          router.replace('/complete-profile');
        }

        try {
          const token = await authUser.getIdToken(true);
          // await loginWithToken(token, setProfile);
          await loginWithToken(token);
        } catch (error) {
          console.error('Error in auth state change:', error);
          // setProfile(null);
          setGroups([]);
        }
      } else {
        try {
          await signInAnonymously(auth);
          // The onAuthStateChanged listener will fire again with the new anonymous user
        } catch (error) {
          console.error('Error signing in anonymously:', error);
          // setProfile(null);
          setGroups([]);
        }
      }
      // Note: We don't set loading to false here immediately after anonymous sign-in,
      // because we want to wait for the listener to run again with the new user.
      // It will be set to false once the authUser block completes.
      if (authUser) {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  // Effect to load the stored group ID on mount
  useEffect(() => {
    const loadSelectedGroup = async () => {
      try {
        const groupId = await AsyncStorage.getItem('selectedGroupId');
        setStoredGroupId(groupId); // Will be string or null
      } catch (e) {
        console.error("Failed to load selected group ID.", e);
      }
    };
    loadSelectedGroup();
  }, []);

  useEffect(() => {
    if (!user) return;

    const userStatusRef = ref(db, `/status/${user.uid}`);
    const connectedRef = ref(db, '.info/connected');

    const unsubscribe = onValue(connectedRef, (snapshot) => {
      if (snapshot.val() === false) {
        // User is not connected to the database.
        // This can be useful for local state updates if needed, but
        // the onDisconnect handler below manages the database state.
        return;
      }

      // When the client's connection is established...
      // 1. Set up the onDisconnect handler. This is the crucial part.
      //    It's a promise that resolves when the write is committed to the server.
      onDisconnect(userStatusRef).set({
        online: false,
        lastOnline: serverTimestamp(),
      }).then(() => {
        // 2. Once the onDisconnect is established, set the user's status to online.
        //    This is the client's "I am here" signal.
        set(userStatusRef, {
          online: true,
        });
      });
    });

    return () => {
      // On cleanup, if the user is logging out cleanly,
      // we can immediately set their status to offline.
      if (user) {
          set(userStatusRef, {
              online: false,
              lastOnline: serverTimestamp()
          });
      }
      unsubscribe();
    };
  }, [user]);

  // Effect to fetch groups and listen for member presence
  useEffect(() => {
    if (!user) {
      setGroups([]);
      setSelectedGroup(null);
      return;
    }

    let presenceListeners: (()=>void)[] = [];

    const fetchGroupsAndListen = async () => {
      try {
        const fetchedGroups = await getGroups();
        presenceListeners.forEach(unsubscribe => unsubscribe());
        presenceListeners = [];

        fetchedGroups.forEach(group => {
          group.members.forEach(member => {
            const memberStatusRef = ref(db, `/status/${member.uid}`);
            const unsubscribe = onValue(memberStatusRef, (snapshot) => {
              const statusUpdate = snapshot.val(); // e.g., { online: true } or { online: false, lastOnline: ... }

              setGroups(currentGroups =>
                currentGroups.map(g =>
                  g.id === group.id
                    ? {
                        ...g,
                        members: g.members.map(m =>
                          m.uid === member.uid 
                            // Spread the new status object onto the member
                            ? { ...m, ...statusUpdate } 
                            : m
                        ),
                      }
                    : g
                )
              );
            });
            presenceListeners.push(unsubscribe);
          });
        });

        setGroups(fetchedGroups);
        if (fetchedGroups.length > 0) {
          const previouslySelected = storedGroupId ? fetchedGroups.find(g => g.id === storedGroupId) : null;
           setSelectedGroup(previouslySelected || fetchedGroups[0]);
        } else {
            setSelectedGroup(null);
        }

      } catch (error) {
        console.error('Failed to fetch groups:', error);
        setGroups([]);
      }
    };
    fetchGroupsAndListen();

    return () => {
      presenceListeners.forEach((unsubscribe) => unsubscribe());
    };
  }, [user]);

  useEffect(() => {
    // Only run if we have a logged-in user and groups have been loaded
    if (user && groups.length > 0) {
      setGroups(currentGroups =>
        currentGroups.map(group => ({
          ...group,
          members: group.members.map(member =>
            // If this member is the current user, update their details
            member.uid === user.uid
              ? { ...member, displayName: user.displayName, photoURL: user.photoURL }
              : member
          )
        }))
      );
    }
  }, [user?.displayName, user?.photoURL]); // This effect re-runs ONLY when your display name or photo URL changes

  // Effect to update selectedGroup when groups array is updated
  useEffect(() => {
    if (selectedGroup) {
      const updatedSelectedGroup = groups.find((g) => g.id === selectedGroup.id);
      if (updatedSelectedGroup) {
        setSelectedGroup(updatedSelectedGroup);
      }
    }
  }, [groups]);


  // Server Time Offset Listener
  useEffect(() => {
    const offsetRef = ref(db, '.info/serverTimeOffset');
    const unsubscribe = onValue(offsetRef, (snapshot) => {
      setServerTimeOffset(snapshot.val() || 0);
    });
    return () => unsubscribe();
  }, []);

  const refreshAuthUser = () => {
    const currentUser = auth.currentUser;
    if (currentUser) {
      // Create a shallow copy to guarantee a new object reference.
      // This is crucial for triggering useEffect dependencies in other parts of the app.
      setUser({ ...currentUser });
    }
  };

  const selectGroup = (group: Group) => {
    setSelectedGroup(group);
    AsyncStorage.setItem('selectedGroupId', group.id).catch(e => {
      console.error("Failed to save selected group.", e);
    });
  };

  const value = {
    user,
    // profile,
    groups,
    selectedGroup,
    selectGroup,
    loading,
    serverTimeOffset,
    refreshAuthUser
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);

export function useProtectedRoute() {
    const { user, loading } = useAuth(); // Assuming you have an 'isInitialized' state
    const segments = useSegments();
    const router = useRouter();

    useEffect(() => {
        // Wait until the auth state is fully initialized
        if (loading) {
            return;
        }

        const inAppGroup = segments[0] === '(tabs)';

        // If the user is signed in and is trying to access an auth screen, redirect to the app.
        if (user && !inAppGroup) {
            router.replace('/list');
        }
    }, [user, segments, loading, router]); // Re-run effect when these change
}