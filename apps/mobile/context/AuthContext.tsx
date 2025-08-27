// context/AuthContext.tsx
import { Group, UserProfile } from '@/types/types';
import { getGroups, loginWithToken } from '@/utils/api';
import { auth } from '@/utils/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import React, { createContext, useContext, useEffect, useState } from 'react';

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  groups: Group[]; 
  selectedGroup: Group | null; 
  selectGroup: (group: Group) => void; 
  loading: boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  profile: null,
  groups: [],
  selectedGroup: null,
  selectGroup: () => {},
  loading: true,
});

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);

  // A local helper function to fetch groups
  const fetchAndSetGroups = async () => {
    try {
      const fetchedGroups = await getGroups();
      setGroups(fetchedGroups);
      if (fetchedGroups.length > 0) {
        setSelectedGroup(fetchedGroups[0]); // ⬅️ Set the first group as default
      }
    } catch (error) {
      console.error('Failed to fetch groups:', error);
      setGroups([]);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (authUser) => {
      setUser(authUser);
     

       if (authUser) {
        try {
          const token = await authUser.getIdToken(true);
          await loginWithToken(token, setProfile);
          await fetchAndSetGroups(); // ⬅️ Fetch groups after successful login
        } catch (error) {
          console.error('Error in auth state change:', error);
          setProfile(null);
          setGroups([]);
        }
      } else {
        setProfile(null);
        setGroups([]);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const selectGroup = (group: Group) => {
    setSelectedGroup(group);
  };

  const value = {
    user,
    profile,
    groups,
    selectedGroup,
    selectGroup,
    loading,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);