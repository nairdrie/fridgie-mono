// context/AuthContext.tsx
import { Group, UserProfile } from '@/types/types';
import { getGroups, loginWithToken } from '@/utils/api';
import { defaultAvatars } from '@/utils/defaultAvatars';
import { auth, db } from '@/utils/firebase';
import { useRouter } from 'expo-router';
import { onAuthStateChanged, signInAnonymously, updateProfile, User } from 'firebase/auth';
import { onDisconnect, onValue, ref, serverTimestamp, set } from 'firebase/database'; // ⬅️ Add serverTimestamp
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

const PRESENCE_PING_INTERVAL_MS = 30000; // 30 seconds

interface UserProfileWithPresence extends UserProfile {
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

  const presenceListeners = useRef<(() => void)[]>([]);
  const presenceInterval = useRef<number | null>(null);

  const router = useRouter();

  // Main Auth State Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (authUser) => {
      setUser(authUser);

      if (authUser) {
        if(authUser.isAnonymous && !authUser.photoURL) {
          const randomPhotoURL = defaultAvatars[Math.floor(Math.random() * defaultAvatars.length)];
          await updateProfile(authUser, {
              photoURL: randomPhotoURL
            });
        }
        if(!authUser.isAnonymous && !authUser.displayName) {
          router.replace('/complete-profile');
        }

        // --- User is logged in (real or anonymous) ---
        const userStatusRef = ref(db, `/status/${authUser.uid}`);
        onDisconnect(userStatusRef).set(serverTimestamp());
        set(userStatusRef, serverTimestamp());

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
        // --- ✅ No user is logged in, attempt to sign in anonymously ---
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

  // Server Time Offset Listener
  useEffect(() => {
    const offsetRef = ref(db, '.info/serverTimeOffset');
    const unsubscribe = onValue(offsetRef, (snapshot) => {
      setServerTimeOffset(snapshot.val() || 0);
    });
    return () => unsubscribe();
  }, []);

  // App State Listener for Periodic Presence Pings
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (!auth.currentUser) return;
      const userStatusRef = ref(db, `/status/${auth.currentUser.uid}`);

      if (nextAppState === 'active') {
        if (presenceInterval.current) clearInterval(presenceInterval.current);
        set(userStatusRef, serverTimestamp());
        // @ts-ignore
        presenceInterval.current = setInterval(() => {
          set(userStatusRef, serverTimestamp());
        }, PRESENCE_PING_INTERVAL_MS);
      } else {
        if (presenceInterval.current) clearInterval(presenceInterval.current);
      }
    });

    return () => {
      subscription.remove();
      if (presenceInterval.current) clearInterval(presenceInterval.current);
    };
  }, []);

  // Effect to fetch groups and listen for member presence
  useEffect(() => {
    if (!user) return; // Only run if we have a user

    const fetchGroupsAndListen = async () => {
      try {
        const fetchedGroups = await getGroups();
        presenceListeners.current.forEach(unsubscribe => unsubscribe());
        presenceListeners.current = [];

        fetchedGroups.forEach(group => {
          group.members.forEach(member => {
            const memberStatusRef = ref(db, `/status/${member.uid}`);
            const unsubscribe = onValue(memberStatusRef, (snapshot) => {
              const lastOnlineTimestamp = snapshot.val(); // This will be a number
              
              setGroups(currentGroups =>
                currentGroups.map(g =>
                  g.id === group.id
                    ? {
                        ...g,
                        members: g.members.map(m =>
                          m.uid === member.uid ? { ...m, lastOnline: lastOnlineTimestamp } : m
                        ),
                      }
                    : g
                )
              );
            });
            presenceListeners.current.push(unsubscribe);
          });
        });

        setGroups(fetchedGroups);
        if (fetchedGroups.length > 0) {
            const currentSelected = selectedGroup ? fetchedGroups.find(g => g.id === selectedGroup.id) : undefined;
            setSelectedGroup(currentSelected || fetchedGroups[0]);
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
      presenceListeners.current.forEach((unsubscribe) => unsubscribe());
      presenceListeners.current = [];
    };
  }, [user]);

  // ✅ This new effect syncs the current user's profile changes into the groups state
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