import { useGlobalSearchParams, useRouter } from 'expo-router'; // ✅ 1. Import the correct hook
import React, { createContext, useContext, useEffect, useState } from 'react';
import { List, ListView } from '../types/types';
import { ApiError, getLists } from '../utils/api';

interface ListContextType {
  groupId: string | undefined;
  allLists: List[];
  selectedList: List | null;
  selectedView: ListView;
  selectList: (list: List | null) => void;
  selectView: (view: ListView) => void;
  isLoading: boolean;
}

const ListContext = createContext<ListContextType | undefined>(undefined);

export function ListProvider({ children }: { children: React.ReactNode }) {
  // ✅ 2. Use the global params hook instead of the local one
  const params = useGlobalSearchParams(); 
  const router = useRouter();

  const groupId = Array.isArray(params.groupId) ? params.groupId[0] : (params.groupId as string | undefined);

  const [allLists, setAllLists] = useState<List[]>([]);
  const [selectedList, setSelectedList] = useState<List | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedView, setSelectedView] = useState<ListView>(ListView.GroceryList);

  useEffect(() => {

    async function fetchAllLists(id: string) {
      try {
        const fetchedLists = await getLists(id);
        setAllLists(fetchedLists);
        if (fetchedLists.length > 0) {
          // Default to the most recent list
          setSelectedList([...fetchedLists].sort((a, b) => new Date(b.weekStart).getTime() - new Date(a.weekStart).getTime())[0]);
        } else {
          setSelectedList(null);
        }
      } catch (error) {
        if (error instanceof ApiError) {
          console.error("Failed to fetch lists:", error);
          if(error.status == 403) {
            router.navigate('/groups');
          }
        }
      } finally {
        setIsLoading(false);
      }
    }

    setIsLoading(true);

    if (!groupId) {
      setAllLists([]);
      setSelectedList(null);
      setIsLoading(false);
      return;
    } 
    else {
      fetchAllLists(groupId);
    }
  }, [groupId]);

  const selectList = (list: List | null) => {
    setSelectedList(list);
  };

   const selectView = (view: ListView) => {
    setSelectedView(view);
  };

  const value = { groupId, allLists, selectedList, selectList, selectedView, selectView, isLoading };

  return <ListContext.Provider value={value}>{children}</ListContext.Provider>;
}

export function useLists() {
  const context = useContext(ListContext);
  if (context === undefined) {
    throw new Error('useLists must be used within a ListProvider');
  }
  return context;
}