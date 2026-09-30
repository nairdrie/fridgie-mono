const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

/**
 * Google Play may move a buyer into their banking app for verification. An
 * Activity using Expo's default `singleTask` launch mode can cancel that flow;
 * RevenueCat recommends `standard` or `singleTop`. Keep this in config (rather
 * than generated android/) so every EAS/prebuild run gets the same safe value.
 */
module.exports = function withRevenueCatAndroidLaunchMode(config) {
  return withAndroidManifest(config, next => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      next.modResults,
    );
    const mainActivity = application.activity?.find(
      activity => activity.$?.['android:name'] === '.MainActivity',
    );
    if (mainActivity?.$) mainActivity.$['android:launchMode'] = 'singleTop';
    return next;
  });
};
