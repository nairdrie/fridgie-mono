import { getShareExtensionKey } from 'expo-share-intent';

/** Keep the extension's transport URL out of the visible navigation stack. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return path.includes(`dataUrl=${getShareExtensionKey()}`) ? '/import-recipe' : path;
  } catch {
    return '/import-recipe';
  }
}
