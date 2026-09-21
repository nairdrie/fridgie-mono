// The temporary existing-signing profile omits the iOS share target and its
// App Group. Normal builds keep the complete app.json configuration.
module.exports = ({ config }) => {
  if (process.env.EXPO_PUBLIC_IOS_SHARE_EXTENSION_ENABLED !== 'false') return config;

  return {
    ...config,
    plugins: (config.plugins ?? []).map(plugin => {
      const [name, options] = Array.isArray(plugin) ? plugin : [plugin, {}];
      return name === 'expo-share-intent'
        ? [name, { ...options, disableIOS: true }]
        : plugin;
    }),
  };
};
