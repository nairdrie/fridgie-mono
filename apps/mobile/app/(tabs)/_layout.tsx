import React from 'react';
import ConnectionError from '@/components/ConnectionError';
import ListHeader from '@/components/ListHeader';
import GlassTabBar from '@/components/ui/GlassTabBar';
import { useAuth } from '@/context/AuthContext';
import { useLists } from '@/context/ListContext';
import { useNotifications } from '@/context/NotificationContext';
import { canvas, primary } from '@/utils/styles';
import { Tabs } from 'expo-router';
import { useGlassPreferences } from '@/components/ui/Glass';

export default function TabLayout() {
  const { reduceMotion } = useGlassPreferences();
  const { groups, groupsError, refreshGroups } = useAuth();
  const { selectedList, loadError, refreshLists } = useLists();
  const { notificationCount } = useNotifications();
  const [retrying, setRetrying] = React.useState(false);
  // A cached week remains usable offline; only a genuinely cold failed start
  // replaces the app with a retry screen.
  const unreachable = (groupsError && groups.length === 0) || (loadError && !selectedList);
  React.useEffect(() => { if (!unreachable) setRetrying(false); }, [unreachable]);
  if (unreachable) return <ConnectionError retrying={retrying} onRetry={() => { setRetrying(true); if (groupsError) refreshGroups(); refreshLists(); }} />;

  return (
    <Tabs tabBar={props => <GlassTabBar {...props} />} screenOptions={{ tabBarActiveTintColor: primary, sceneStyle: { backgroundColor: canvas }, animation: reduceMotion ? 'none' : 'fade' }}>
      <Tabs.Screen name="list" options={{ title: 'Plan', header: () => <ListHeader /> }} />
      <Tabs.Screen name="explore" options={{ title: 'Discover', headerShown: false }} />
      <Tabs.Screen
        name="profile"
        options={{ title: 'You', headerShown: false, tabBarBadge: notificationCount > 0 ? notificationCount : undefined }}
        listeners={({ navigation }) => ({ tabPress: event => { event.preventDefault(); navigation.navigate('profile', { uid: undefined }); } })}
      />
    </Tabs>
  );
}
