import { useAuth } from '@/context/AuthContext';
import { useSharedRecipes } from '@/context/SharedRecipeContext';
import { usePathname, useRootNavigationState, useRouter } from 'expo-router';
import { useEffect } from 'react';

/** Resume the same link after login/profile setup, including a cold launch. */
export default function SharedRecipeRouter() {
  const { requests, ready } = useSharedRecipes();
  const { user, loading } = useAuth();
  const navigation = useRootNavigationState();
  const pathname = usePathname();
  const router = useRouter();
  const pendingId = requests[0]?.id;

  useEffect(() => {
    if (!ready || loading || !user || !navigation?.key || !pendingId) return;
    if (pathname === '/import-recipe' || pathname === '/login' || pathname === '/complete-profile') return;
    if (!user.isAnonymous && !user.displayName) return;
    router.push('/import-recipe');
  }, [ready, loading, user, navigation?.key, pendingId, pathname, router]);

  return null;
}
