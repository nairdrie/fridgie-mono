// context/AuthContext.tsx
import { Group, UserProfile } from '@/types/types';
import { getGroups, loginWithToken, registerForPushNotificationsAsync } from '@/utils/api';
import { defaultAvatars } from '@/utils/defaultAvatars';
import { auth, db } from '@/utils/firebase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, useSegments } from 'expo-router';
import { onAuthStateChanged, signInAnonymously, updateProfile, User } from 'firebase/auth';
import { goOnline, onDisconnect, onValue, ref, serverTimestamp, set } from 'firebase/database'; // ⬅️ Add serverTimestamp
import React, { useCallback, useRef, useMemo, createContext, useContext, useEffect, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';

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
  /** Set when loading the user's groups failed. Nothing renders without a group. */
  groupsError: Error | null;
  /** Re-runs the group fetch. Safe to call at any time. */
  refreshGroups: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  // profile: null,
  groups: [],
  selectedGroup: null,
  selectGroup: () => {},
  loading: true,
  serverTimeOffset: 0, // Add initial value
  refreshAuthUser: () => {},
  groupsError: null,
  refreshGroups: () => {}
});

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  // const [profile, setProfile] = useState<UserProfile | null>(null);
  const [groups, setGroups] = useState<GroupWithPresence[]>([]);
  const [groupsError, setGroupsError] = useState<Error | null>(null);
  /** Live presence per uid, kept separate from `groups` and merged at render. */
  const [presence, setPresence] = useState<Record<string, { online?: boolean; lastOnline?: number }>>({});
  // Bumping this re-runs the group fetch. Without it a single failed load was
  // permanent: selectedGroup stayed null, so ListContext cleared with no error
  // of its own, and the whole header silently rendered nothing.
  const [groupsReloadToken, setGroupsReloadToken] = useState(0);
  const refreshGroups = useCallback(() => setGroupsReloadToken((t) => t + 1), []);

  // Retry when the app returns to the foreground, but only while in a failed
  // state, so ordinary app switching doesn't refetch.
  const groupsErrorRef = useRef<Error | null>(null);
  groupsErrorRef.current = groupsError;
  useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      if (state === 'active' && groupsErrorRef.current) refreshGroups();
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [refreshGroups]);

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
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        // When the app comes to the foreground, ensure the connection is online.
        // This will trigger your '.info/connected' listener and reset your online status.
        goOnline(db);
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  // Keyed on the uid, NOT the user object. refreshAuthUser deliberately hands
  // back a fresh object reference to retrigger effects elsewhere, and this one
  // writes `online: false` in its cleanup — so every refresh marked you offline
  // immediately, then only restored `online: true` after an onDisconnect
  // round-trip. Anything interrupting that window left you showing offline.
  useEffect(() => {
    if (!user?.uid) return;
    const uid = user.uid;

    const userStatusRef = ref(db, `/status/${uid}`);
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
      // Stop the connection listener first so it can't race us back online,
      // then clear the server-side disconnect hook and write offline. Both
      // writes can fail if auth was already torn down (e.g. after signOut), so
      // swallow errors — the onDisconnect handler is the fallback.
      unsubscribe();
      onDisconnect(userStatusRef).cancel().catch(() => {});
      set(userStatusRef, {
          online: false,
          lastOnline: serverTimestamp()
      }).catch(() => {});
    };
  }, [user?.uid]);

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

        // Presence is kept in its own map keyed by uid, NOT merged into `groups`
        // here. These listeners fire their initial value immediately, and the
        // `setGroups(fetchedGroups)` below used to run after them — so the first
        // presence snapshot was applied to the previous array and then thrown
        // away. Since presence only pushes again when a status *changes*, and
        // your own "online: true" is written before this runs, you could sit
        // there showing offline indefinitely. Merging at render removes the
        // ordering dependency entirely.
        const seen = new Set<string>();
        fetchedGroups.forEach(group => {
          group.members.forEach(member => {
            if (seen.has(member.uid)) return;   // one listener per user, not per membership
            seen.add(member.uid);

            const memberStatusRef = ref(db, `/status/${member.uid}`);
            const unsubscribe = onValue(memberStatusRef, (snapshot) => {
              const status = snapshot.val() as { online?: boolean; lastOnline?: number } | null;
              setPresence(prev => ({ ...prev, [member.uid]: status ?? { online: false } }));
            });
            presenceListeners.push(unsubscribe);
          });
        });

        setGroups(fetchedGroups);
        setGroupsError(null);
        if (fetchedGroups.length > 0) {
          const previouslySelected = storedGroupId ? fetchedGroups.find(g => g.id === storedGroupId) : null;
           setSelectedGroup(previouslySelected || fetchedGroups[0]);
        } else {
            setSelectedGroup(null);
        }

      } catch (error) {
        console.error('Failed to fetch groups:', error);
        setGroups([]);
        setGroupsError(error instanceof Error ? error : new Error(String(error)));
      }
    };
    fetchGroupsAndListen();

    return () => {
      presenceListeners.forEach((unsubscribe) => unsubscribe());
    };
    // uid, not the user object — refreshAuthUser replaces that reference on
    // purpose, and re-fetching every group and re-attaching every presence
    // listener on a display-name change is pure churn.
  }, [user?.uid, groupsReloadToken]);

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

  // Presence is merged in here rather than written into `groups`, so a slow or
  // fast RTDB callback can't be clobbered by the group fetch landing after it.
  // The current user is always shown online — they're holding the phone, and
  // trusting a round-trip to tell us that is what made your own avatar grey.
  const groupsWithPresence = useMemo<GroupWithPresence[]>(() => groups.map(group => ({
    ...group,
    members: group.members.map(member => ({
      ...member,
      ...(presence[member.uid] ?? {}),
      ...(user && member.uid === user.uid ? { online: true } : {}),
    })),
  })), [groups, presence, user]);

  const selectedGroupWithPresence = useMemo<GroupWithPresence | null>(
    () => (selectedGroup ? groupsWithPresence.find(g => g.id === selectedGroup.id) ?? selectedGroup : null),
    [groupsWithPresence, selectedGroup]
  );

  const value = {
    user,
    // profile,
    groups: groupsWithPresence,
    selectedGroup: selectedGroupWithPresence,
    selectGroup,
    loading,
    serverTimeOffset,
    refreshAuthUser,
    groupsError,
    refreshGroups
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