import { useRouter } from 'expo-router';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { List, ListView } from '../types/types';
import { ApiError, getLists } from '../utils/api';
import { GroupWithPresence, useAuth } from './AuthContext';

interface ListContextType {
  selectedGroup: GroupWithPresence | null;
  allLists: List[];
  selectedList: List | null;
  selectedView: ListView;
  selectList: (list: List | null) => void;
  selectView: (view: ListView) => void;
  isLoading: boolean;
}

const ListContext = createContext<ListContextType | undefined>(undefined);

export function ListProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { selectedGroup } = useAuth();

  const [allLists, setAllLists] = useState<List[]>([]);
  const [selectedList, setSelectedList] = useState<List | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedView, setSelectedView] = useState<ListView>(ListView.GroceryList);

  useEffect(() => {
    // This flag prevents state updates if the component unmounts or the dependency changes
    // while a fetch is in progress. This is the key to preventing race conditions.
    let ignore = false;

    async function fetchAndSetLists(groupId: string) {
      setIsLoading(true);
      try {
        const fetchedLists = await getLists(groupId);

        // If the effect has been re-run, ignore the results of this old fetch.
        if (ignore) return;

        setAllLists(fetchedLists);

        if (fetchedLists.length > 0) {
          // Your existing logic to select the most recent list by default
          const sortedLists = [...fetchedLists].sort((a, b) => new Date(b.weekStart).getTime() - new Date(a.weekStart).getTime());
          const listWithContent = sortedLists.find(list => list.hasContent);
          setSelectedList(listWithContent || sortedLists[0]);
        } else {
          setSelectedList(null);
        }

      } catch (error) {
        if (ignore) return; // Also ignore errors from stale fetches

        console.error("Failed to fetch lists:", error);
        if (error instanceof ApiError && error.status === 403) {
          // This can happen in a race condition on login.
          // Navigating to a safe page is a good fallback.
          router.navigate('/(tabs)/profile');
        }
        // Always clear lists on an error to avoid showing stale/incorrect data
        setAllLists([]);
        setSelectedList(null);

      } finally {
        if (!ignore) {
          setIsLoading(false);
        }
      }
    }

    if (selectedGroup?.id) {
      fetchAndSetLists(selectedGroup.id);
    } else {
      // If there's no selected group, clear everything out.
      setAllLists([]);
      setSelectedList(null);
      setIsLoading(false);
    }

    // This cleanup function runs when the component unmounts OR when the effect re-runs.
    // It sets the ignore flag, so any in-flight fetch requests from the *previous*
    // render will not be able to update the state.
    return () => {
      ignore = true;
    };
    // ✅ DEPEND ON THE STABLE ID, NOT THE OBJECT
  }, [selectedGroup?.id]); // Now, this effect only re-runs when the actual group changes.

  const selectList = (list: List | null) => {
    setSelectedList(list);
  };

  const selectView = (view: ListView) => {
    setSelectedView(view);
  };

  const value = { selectedGroup, allLists, selectedList, selectList, selectedView, selectView, isLoading };

  return <ListContext.Provider value={value}>{children}</ListContext.Provider>;
}

export function useLists() {
  const context = useContext(ListContext);
  if (context === undefined) {
    throw new Error('useLists must be used within a ListProvider');
  }
  return context;
}