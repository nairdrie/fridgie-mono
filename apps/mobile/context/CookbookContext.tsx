// Which recipes are on the SIGNED-IN user's shelf.
//
// WHY THIS IS A CONTEXT AND NOT A PROP
//
// "Is this in the cookbook?" is a question about the person holding the phone,
// and it gets asked from screens that are showing somebody ELSE's food: a
// recipe opened from Explore, from a creator's profile, from another member's
// cookbook. Every screen used to answer it from whatever list it happened to be
// rendering, which is right only when that list is your own — so a recipe on
// another user's profile read as "In Cookbook" because it was in THEIRS, and
// the button underneath it offered to remove it.
//
// One answer, owned in one place, is what stops that: the screens say which
// recipe, never whether it is yours.
//
// The set is the truth the UI reads AND the thing the toggles write, so a
// recipe added from Explore is immediately "In Cookbook" on a profile, in the
// meal plan and on the rating screen without any of them refetching.

import { getUserCookbook, addUserCookbookRecipe, removeUserCookbookRecipe } from '@/utils/api';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';

interface CookbookContextType {
  /**
   * Recipe ids on the signed-in user's shelf. Empty while it is still loading,
   * and for a signed-out or anonymous user — who has no cookbook to be in.
   */
  recipeIds: ReadonlySet<string>;
  isInCookbook: (recipeId: string | null | undefined) => boolean;
  /**
   * Puts a recipe on the signed-in user's shelf. Optimistic: the set moves
   * first and is put back if the write fails, which it re-throws so the caller
   * can say so.
   */
  addRecipe: (recipeId: string) => Promise<void>;
  /** Takes a recipe off the signed-in user's shelf. Same contract as `addRecipe`. */
  removeRecipe: (recipeId: string) => Promise<void>;
  /** Re-reads the shelf from the server. */
  refresh: () => Promise<void>;
}

const EMPTY: ReadonlySet<string> = new Set();

const CookbookContext = createContext<CookbookContextType>({
  recipeIds: EMPTY,
  isInCookbook: () => false,
  addRecipe: async () => {},
  removeRecipe: async () => {},
  refresh: async () => {},
});

export const CookbookProvider = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth();
  const [recipeIds, setRecipeIds] = useState<ReadonlySet<string>>(EMPTY);

  // An anonymous install has no cookbook — the API refuses to write one (see
  // `requireAccount`), so reading one would be a request that can only come
  // back empty.
  const uid = user && !user.isAnonymous ? user.uid : null;

  // Which shelf the answer in flight is about. Signing in as somebody else
  // while a fetch is out would otherwise paint their recipes onto this one.
  const loadingFor = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    loadingFor.current = uid;
    if (!uid) {
      setRecipeIds(EMPTY);
      return;
    }
    try {
      const recipes = await getUserCookbook(uid);
      if (loadingFor.current !== uid) return;
      setRecipeIds(new Set(recipes.map((recipe) => recipe.id)));
    } catch (error) {
      // Not fatal and deliberately silent: the cost is a button that offers to
      // add a recipe already on the shelf, and the API treats that as the no-op
      // it is rather than a second copy.
      console.error('Could not load your cookbook:', error);
    }
  }, [uid]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addRecipe = useCallback(async (recipeId: string) => {
    setRecipeIds((prev) => new Set(prev).add(recipeId));
    try {
      await addUserCookbookRecipe(recipeId);
    } catch (error) {
      setRecipeIds((prev) => {
        const next = new Set(prev);
        next.delete(recipeId);
        return next;
      });
      throw error;
    }
  }, []);

  const removeRecipe = useCallback(async (recipeId: string) => {
    setRecipeIds((prev) => {
      const next = new Set(prev);
      next.delete(recipeId);
      return next;
    });
    try {
      await removeUserCookbookRecipe(recipeId);
    } catch (error) {
      setRecipeIds((prev) => new Set(prev).add(recipeId));
      throw error;
    }
  }, []);

  const isInCookbook = useCallback(
    (recipeId: string | null | undefined) => !!recipeId && recipeIds.has(recipeId),
    [recipeIds],
  );

  const value = useMemo(
    () => ({ recipeIds, isInCookbook, addRecipe, removeRecipe, refresh }),
    [recipeIds, isInCookbook, addRecipe, removeRecipe, refresh],
  );

  return <CookbookContext.Provider value={value}>{children}</CookbookContext.Provider>;
};

export const useCookbook = () => useContext(CookbookContext);
