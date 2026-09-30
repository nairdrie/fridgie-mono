import type { DiscoverAdvertisingConfig } from '@/types/types';
import { recordDiscoverAdEvent, type DiscoverAdEvent, type DiscoverAdEventProvider } from '@/utils/api';
import { canRequestDiscoverAds, dismissDiscoverAd, DiscoverAdSession, type AdEntitlementState } from '@/utils/discoverAds';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, StyleSheet, View } from 'react-native';
import { loadFirstDiscoverAd, providersFor, type LoadedDiscoverAd } from './providers';

export function DiscoverSponsoredSlot({
  config,
  entitlement,
  session,
  scrollTick,
}: {
  config: DiscoverAdvertisingConfig;
  entitlement: AdEntitlementState;
  session: DiscoverAdSession;
  scrollTick: number;
}) {
  const router = useRouter();
  const [loaded, setLoaded] = useState<LoadedDiscoverAd | null>(null);
  const loadedRef = useRef<LoadedDiscoverAd | null>(null);

  const metric = useCallback((event: DiscoverAdEvent, provider: DiscoverAdEventProvider) => {
    void recordDiscoverAdEvent(event, provider).catch(() => {});
  }, []);

  useEffect(() => {
    let active = true;
    if (!canRequestDiscoverAds(config, entitlement) || !session.canLoad(config.cadence.maxPerSession)) {
      loadedRef.current?.destroy();
      loadedRef.current = null;
      setLoaded(null);
      return;
    }
    // A dependency change destroys the previous SDK object in the prior
    // effect's cleanup; do not render that stale card while its replacement
    // is loading or no-fills.
    setLoaded(null);
    void loadFirstDiscoverAd(providersFor(config), { config, session, onMetric: metric }).then(ad => {
      if (!active) ad?.destroy();
      else {
        loadedRef.current?.destroy();
        loadedRef.current = ad;
        setLoaded(ad);
      }
    });
    return () => {
      active = false;
      loadedRef.current?.destroy();
      loadedRef.current = null;
    };
  }, [config, entitlement, metric, session]);

  const hide = useCallback(() => {
    if (!loaded) return;
    dismissDiscoverAd(session, loaded.id, 'hide', event => metric(event, loaded.provider));
    if (loadedRef.current === loaded) loadedRef.current = null;
    loaded.destroy();
    setLoaded(null);
  }, [loaded, metric, session]);

  const report = useCallback(() => {
    if (!loaded) return;
    dismissDiscoverAd(session, loaded.id, 'report', event => metric(event, loaded.provider));
    if (loadedRef.current === loaded) loadedRef.current = null;
    loaded.destroy();
    setLoaded(null);
    Alert.alert('Ad reported', 'Thanks. This card has been hidden for the rest of this session.');
  }, [loaded, metric, session]);

  const explain = useCallback((explanation: string) => {
    Alert.alert('Why this ad?', explanation);
  }, []);

  const houseCta = useCallback((destinationUrl: string) => {
    metric('click', 'house');
    if (destinationUrl.startsWith('/')) {
      router.push(destinationUrl as never);
      return;
    }
    void Linking.openURL(destinationUrl).catch(() => {
      Alert.alert('Couldn’t open this link', 'Try again when your connection is ready.');
    });
  }, [metric, router]);

  // Effects destroy the provider handle after a transition commits, but the
  // render itself must already hide the old card. This prevents a one-frame ad
  // leak while a purchase, refresh error, or account switch turns entitlement
  // back into a fail-closed state.
  if (!loaded || !canRequestDiscoverAds(config, entitlement)) return null;
  return <View style={styles.slot}>
    {loaded.render({
      scrollTick,
      onHide: hide,
      onReport: report,
      onWhy: explain,
      onHouseImpression: () => metric('impression', 'house'),
      onHouseCta: houseCta,
    })}
  </View>;
}

const styles = StyleSheet.create({
  slot: { marginTop: 18, marginBottom: 8 },
});
