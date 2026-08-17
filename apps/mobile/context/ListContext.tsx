import { useRouter } from 'expo-router';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { List, ListView } from '../types/types';
import { ApiError, getLists } from '../utils/api';
import { parseWeekStart } from '../utils/date';
import { GroupWithPresence, useAuth } from './AuthContext';

interface ListContextType {
  selectedGroup: GroupWithPresence | null;
  allLists: List[];
  selectedList: List | null;
  selectedView: ListView;
  selectList: (list: List | null) => void;
  selectView: (view: ListView) => void;
  isLoading: boolean;
  /** Set when the last load failed. The header shows a retry rather than nothing. */
  loadError: Error | null;
  /** Re-runs the fetch. Safe to call at any time. */
  refreshLists: () => void;
}

const ListContext = createContext<ListContextType | undefined>(undefined);

export function ListProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { selectedGroup } = useAuth();

  const [allLists, setAllLists] = useState<List[]>([]);
  const [selectedList, setSelectedList] = useState<List | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedView, setSelectedView] = useState<ListView>(ListView.GroceryList);
  const [loadError, setLoadError] = useState<Error | null>(null);

  // Bumping this re-runs the fetch effect. Without it a single failed load at
  // startup was permanent: the effect keyed only on the group id, so if the API
  // was unreachable when the app opened, selectedList stayed null — and the
  // whole header renders nothing without it — until the app was restarted.
  const [reloadToken, setReloadToken] = useState(0);
  const refreshLists = useCallback(() => setReloadToken((t) => t + 1), []);

  // Retry when the app comes back to the foreground, but only if we're in a
  // failed state — otherwise every app switch would refetch.
  const loadErrorRef = useRef<Error | null>(null);
  loadErrorRef.current = loadError;

  useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      if (state === 'active' && loadErrorRef.current) refreshLists();
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [refreshLists]);

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
        setLoadError(null);

        if (fetchedLists.length > 0) {
          // Your existing logic to select the most recent list by default
          const sortedLists = [...fetchedLists].sort((a, b) => parseWeekStart(b.weekStart).getTime() - parseWeekStart(a.weekStart).getTime());
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
        setLoadError(error instanceof Error ? error : new Error(String(error)));

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
      setLoadError(null);
      setIsLoading(false);
    }

    // This cleanup function runs when the component unmounts OR when the effect re-runs.
    // It sets the ignore flag, so any in-flight fetch requests from the *previous*
    // render will not be able to update the state.
    return () => {
      ignore = true;
    };
    // ✅ DEPEND ON THE STABLE ID, NOT THE OBJECT
  }, [selectedGroup?.id, reloadToken]); // reloadToken lets a failed load be retried.

  const selectList = (list: List | null) => {
    setSelectedList(list);
  };

  const selectView = (view: ListView) => {
    setSelectedView(view);
  };

  const value = {
    selectedGroup, allLists, selectedList, selectList,
    selectedView, selectView, isLoading, loadError, refreshLists,
  };

  return <ListContext.Provider value={value}>{children}</ListContext.Provider>;
}

export function useLists() {
  const context = useContext(ListContext);
  if (context === undefined) {
    throw new Error('useLists must be used within a ListProvider');
  }
  return context;
}