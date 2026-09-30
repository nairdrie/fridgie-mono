const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

/**
 * Google Play may move a buyer into their banking app for verification. An
 * Activity using Expo's default `singleTask` launch mode can cancel that flow;
 * RevenueCat recommends `standard` or `singleTop`.
 *
 * Expo's scheme helper only recognizes singleTask, while expo-share-intent
 * lets this project intentionally override its default to singleTop. Preserve
 * the app and dev-client schemes explicitly so checkout safety does not break
 * OAuth/deep links or development-client launches.
 */
module.exports = function withRevenueCatAndroidLaunchMode(config) {
  return withAndroidManifest(config, next => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      next.modResults,
    );
    const mainActivity = application.activity?.find(
      activity => activity.$?.['android:name'] === '.MainActivity',
    );
    if (mainActivity?.$) {
      mainActivity.$['android:launchMode'] = 'singleTop';

      const configured = Array.isArray(next.scheme)
        ? next.scheme
        : typeof next.scheme === 'string' ? [next.scheme] : [];
      const schemes = new Set([
        ...configured.filter(value => typeof value === 'string' && value.trim()),
        ...(typeof next.slug === 'string' && next.slug.trim() ? [`exp+${next.slug.trim()}`] : []),
      ]);
      const filters = mainActivity['intent-filter'] ??= [];
      let viewFilter = filters.find(filter => {
        const actions = (filter.action ?? []).map(item => item.$?.['android:name']);
        const categories = (filter.category ?? []).map(item => item.$?.['android:name']);
        return actions.includes('android.intent.action.VIEW')
          && categories.includes('android.intent.category.DEFAULT')
          && categories.includes('android.intent.category.BROWSABLE');
      });
      if (!viewFilter) {
        viewFilter = {
          action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
          category: [
            { $: { 'android:name': 'android.intent.category.DEFAULT' } },
            { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
          ],
          data: [],
        };
        filters.push(viewFilter);
      }
      viewFilter.data ??= [];
      const existing = new Set(viewFilter.data.map(item => item.$?.['android:scheme']));
      for (const scheme of schemes) {
        if (!existing.has(scheme)) viewFilter.data.push({ $: { 'android:scheme': scheme } });
      }
    }
    return next;
  });
};
