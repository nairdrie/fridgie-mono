import { useRouter } from 'expo-router';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { List, ListView } from '../types/types';
import { ApiError, getLists } from '../utils/api';
import { flushCache, pruneCachedLists, readCachedSummaries, writeCachedSummaries } from '../utils/listCache';
import { flushAllDirty, resumeUnsavedWork } from '../utils/listSync';
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
      if (state === 'active') {
        if (loadErrorRef.current) refreshLists();
        // Coming back to the app is one of the three moments a save that has
        // been failing might now work — the other two being the websocket
        // reconnecting and the connection being reported back, both of which
        // the engine wires up itself.
        void flushAllDirty();
        return;
      }
      // Leaving is the last chance to get the mirror onto disk. Cache writes are
      // debounced so they don't stutter the keyboard, which means there is
      // normally one in flight; if the OS reclaims the app in a supermarket,
      // this is what decides whether the last few seconds of edits survive.
      void flushCache();
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [refreshLists]);

  // Anything left unsaved by a previous run of the app — edits made in a shop
  // with no signal, then the app killed by the OS before it came back. Picking
  // these up at startup is what stops them waiting for the user to happen to
  // re-open that particular week.
  useEffect(() => {
    void resumeUnsavedWork();
  }, []);

  // The week the user actually chose, readable without making `applyLists` a
  // dependency of anything. Cached weeks arrive first and the network's answer
  // lands on top; re-running the default-selection logic on that second pass
  // would yank the user off a week they had already switched to.
  const selectedListIdRef = useRef<string | null>(null);
  selectedListIdRef.current = selectedList?.id ?? null;

  useEffect(() => {
    // This flag prevents state updates if the component unmounts or the dependency changes
    // while a fetch is in progress. This is the key to preventing race conditions.
    let ignore = false;

    const applyLists = (lists: List[]) => {
      setAllLists(lists);
      if (lists.length === 0) {
        setSelectedList(null);
        return;
      }
      // Keep the user's choice if it is still one of the weeks on offer.
      const chosen = selectedListIdRef.current
        ? lists.find(l => l.id === selectedListIdRef.current)
        : null;
      if (chosen) {
        setSelectedList(chosen);
        return;
      }
      const sortedLists = [...lists].sort((a, b) => parseWeekStart(b.weekStart).getTime() - parseWeekStart(a.weekStart).getTime());
      const listWithContent = sortedLists.find(list => list.hasContent);
      setSelectedList(listWithContent || sortedLists[0]);
    };

    async function fetchAndSetLists(groupId: string) {
      setIsLoading(true);

      // The cached set of weeks FIRST. Without it a phone with no signal has no
      // week to select, and the list screen renders nothing at all — every list
      // document could be sitting safely on disk and the user would still be
      // looking at an error screen, because nothing had got as far as choosing
      // which week to show them.
      const cached = await readCachedSummaries(groupId);
      if (ignore) return;
      if (cached && cached.length > 0) {
        applyLists(cached as List[]);
        setIsLoading(false);
      }

      try {
        const fetchedLists = await getLists(groupId);

        // If the effect has been re-run, ignore the results of this old fetch.
        if (ignore) return;

        applyLists(fetchedLists);
        setLoadError(null);
        void writeCachedSummaries(groupId, fetchedLists);
        // Old weeks are read-only history; anything still holding unsaved edits
        // is kept regardless of age.
        void pruneCachedLists(groupId, fetchedLists.map((l: List) => l.id));

      } catch (error) {
        if (ignore) return; // Also ignore errors from stale fetches

        console.error("Failed to fetch lists:", error);
        if (error instanceof ApiError && error.status === 403) {
          // This can happen in a race condition on login.
          // Navigating to a safe page is a good fallback.
          router.navigate('/(tabs)/profile');
        }
        setLoadError(error instanceof Error ? error : new Error(String(error)));

        // Clearing on an error is right ONLY when there is nothing trustworthy
        // to show. Cached weeks are not "stale/incorrect data" — they are the
        // last thing the server told us, they are what the user was working on
        // five minutes ago, and throwing them away is what made the app useless
        // the moment the signal dropped.
        if (!cached || cached.length === 0) {
          setAllLists([]);
          setSelectedList(null);
        }

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