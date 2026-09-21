import { extractRecipeImportUrl } from '@/utils/recipeImport';
import { appendSharedRecipe, decodeSharedRecipeInbox, removeSharedRecipe, SHARED_RECIPE_INBOX_KEY, SharedRecipeRequest } from '@/utils/sharedRecipeInbox';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLinkingURL } from 'expo-linking';
import { ShareIntentModule, useShareIntentContext } from 'expo-share-intent';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import uuid from 'react-native-uuid';

interface SharedRecipeContextValue {
  requests: SharedRecipeRequest[];
  ready: boolean;
  error: string | null;
  enqueue: (input: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  retry: () => void;
}

const SharedRecipeContext = createContext<SharedRecipeContextValue | null>(null);

export function SharedRecipeProvider({ children }: { children: React.ReactNode }) {
  const { isReady: nativeReady, hasShareIntent, shareIntent, resetShareIntent, error: nativeError } = useShareIntentContext();
  const incomingURL = useLinkingURL();
  const [requests, setRequests] = useState<SharedRecipeRequest[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const inbox = useRef<SharedRecipeRequest[]>([]);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const processing = useRef<string | null>(null);
  const resetNative = useRef(resetShareIntent);
  resetNative.current = resetShareIntent;

  useEffect(() => {
    // v4 requests the cold-launch payload before registering native listeners.
    // Read once listeners are ready too; the inbox deduplicates repeated events.
    if (Platform.OS === 'ios' && nativeReady && incomingURL?.startsWith('fridgie://dataUrl=fridgieShareKey')) {
      void Promise.resolve(ShareIntentModule?.getShareIntent(incomingURL)).catch(() => {
        setError('Couldn’t receive this shared link. Copy it and paste it in Fridgie.');
      });
    }
  }, [nativeReady, incomingURL]);

  useEffect(() => {
    if (ready) return;
    let active = true;
    void AsyncStorage.getItem(SHARED_RECIPE_INBOX_KEY).then(value => {
      if (!active) return;
      inbox.current = decodeSharedRecipeInbox(value);
      setRequests(inbox.current);
      setError(null);
      setReady(true);
    }).catch(() => {
      if (active) setError('Couldn’t restore your shared recipe. Try again.');
    });
    return () => { active = false; };
  }, [ready, retryCount]);

  const update = useCallback((change: (previous: SharedRecipeRequest[]) => SharedRecipeRequest[]) => {
    const operation = writes.current.then(async () => {
      const next = change(inbox.current);
      // Do not clear the OS payload or close a draft until it is safely recorded.
      await AsyncStorage.setItem(SHARED_RECIPE_INBOX_KEY, JSON.stringify(next));
      inbox.current = next;
      setRequests(next);
      setError(null);
    });
    writes.current = operation.catch(() => {});
    return operation;
  }, []);

  const enqueue = useCallback(async (input: string) => {
    if (!ready) throw new Error('Your shared recipes are still loading.');
    const request: SharedRecipeRequest = {
      id: String(uuid.v4()),
      input: extractRecipeImportUrl(input) ?? input.trim(),
      receivedAt: Date.now(),
    };
    await update(previous => appendSharedRecipe(previous, request));
  }, [ready, update]);

  const dismiss = useCallback((id: string) => update(previous => removeSharedRecipe(previous, id)), [update]);

  useEffect(() => {
    if (!hasShareIntent) { processing.current = null; return; }
    if (!ready) return;
    // TikTok/Instagram often send prose around a URL; Safari supplies webUrl.
    const input = shareIntent.text?.trim() || shareIntent.webUrl?.trim() || '';
    const fingerprint = JSON.stringify([shareIntent.text, shareIntent.webUrl]);
    if (processing.current === fingerprint) return;
    processing.current = fingerprint;
    if (!input) {
      setError('Share a TikTok, Instagram Reel, or recipe website link to import it.');
      resetNative.current();
      return;
    }
    void enqueue(input).then(() => {
      if (processing.current === fingerprint) resetNative.current();
    }).catch(() => {
      setError('Couldn’t keep this shared link. Try again before leaving Fridgie.');
    });
  }, [hasShareIntent, shareIntent.text, shareIntent.webUrl, ready, enqueue, retryCount]);

  const retry = useCallback(() => { processing.current = null; setRetryCount(value => value + 1); }, []);

  return <SharedRecipeContext.Provider value={{ requests, ready, error: error ?? (nativeError ? 'Couldn’t receive this share. Copy the recipe link and paste it in Fridgie.' : null), enqueue, dismiss, retry }}>{children}</SharedRecipeContext.Provider>;
}

export function useSharedRecipes() {
  const context = useContext(SharedRecipeContext);
  if (!context) throw new Error('useSharedRecipes must be inside SharedRecipeProvider');
  return context;
}
