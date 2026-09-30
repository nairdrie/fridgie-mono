import { BrandMark } from '@/components/ui/Brand';
import { GlassPressable } from '@/components/ui/Glass';
import type { DiscoverAdvertisingConfig, DiscoverHouseAd } from '@/types/types';
import { recordDiscoverAdEvent, type DiscoverAdEvent, type DiscoverAdEventProvider } from '@/utils/api';
import { DiscoverAdSession, sponsoredCardPresentation } from '@/utils/discoverAds';
import { ink, inkMuted, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import React, { useEffect, useRef } from 'react';
import { Dimensions, Image, Platform, StyleSheet, Text, View } from 'react-native';

type GoogleAdsSdk = typeof import('react-native-google-mobile-ads');
type GoogleNativeAd = import('react-native-google-mobile-ads').NativeAd;

export interface DiscoverAdRenderProps {
  scrollTick: number;
  onHide: () => void;
  onReport: () => void;
  onWhy: (explanation: string) => void;
  onHouseImpression: () => void;
  onHouseCta: (destinationUrl: string) => void;
}

/** Provider-owned rendering keeps native SDK handles out of feed rows/state. */
export interface LoadedDiscoverAd {
  id: string;
  provider: DiscoverAdEventProvider;
  render(props: DiscoverAdRenderProps): React.ReactElement;
  destroy(): void;
}

export interface DiscoverAdProviderRequest {
  config: DiscoverAdvertisingConfig;
  session: DiscoverAdSession;
  onMetric: (event: DiscoverAdEvent, provider: DiscoverAdEventProvider) => void;
}

export interface DiscoverAdProvider {
  readonly name: 'house' | 'admob' | 'no-fill';
  load(request: DiscoverAdProviderRequest): Promise<LoadedDiscoverAd | null>;
}

function track(event: DiscoverAdEvent, provider: DiscoverAdEventProvider) {
  // Metrics are deliberately fire-and-forget and must never disturb the feed.
  void recordDiscoverAdEvent(event, provider).catch(() => {});
}

function AdControls({
  presentation,
  onWhy,
  onHide,
  onReport,
}: {
  presentation: ReturnType<typeof sponsoredCardPresentation>;
  onWhy: (explanation: string) => void;
  onHide: () => void;
  onReport: () => void;
}) {
  return <View style={styles.controls}>
    <GlassPressable haptic={false} style={styles.control} onPress={() => onWhy(presentation.why)} accessibilityLabel={presentation.actionLabels.why}>
      <Ionicons name="information-circle-outline" size={14} color={inkMuted} />
      <Text style={styles.controlText}>Why this ad?</Text>
    </GlassPressable>
    <GlassPressable haptic={false} style={styles.control} onPress={onHide} accessibilityLabel={presentation.actionLabels.hide}>
      <Ionicons name="eye-off-outline" size={14} color={inkMuted} />
      <Text style={styles.controlText}>Hide</Text>
    </GlassPressable>
    <GlassPressable haptic={false} style={styles.control} onPress={onReport} accessibilityLabel={presentation.actionLabels.report}>
      <Ionicons name="flag-outline" size={14} color={inkMuted} />
      <Text style={styles.controlText}>Report</Text>
    </GlassPressable>
  </View>;
}

function HouseSponsoredCard({ ad, scrollTick, onHide, onReport, onWhy, onImpression, onCta }: {
  ad: DiscoverHouseAd;
  scrollTick: number;
  onHide: () => void;
  onReport: () => void;
  onWhy: (explanation: string) => void;
  onImpression: () => void;
  onCta: (destinationUrl: string) => void;
}) {
  const card = useRef<View>(null);
  const impressed = useRef(false);
  const presentation = sponsoredCardPresentation('house', ad.brand);

  useEffect(() => {
    if (impressed.current) return;
    const frame = requestAnimationFrame(() => {
      card.current?.measureInWindow((_x, y, _width, height) => {
        if (!height) return;
        const viewportHeight = Dimensions.get('window').height;
        const visible = Math.min(y + height, viewportHeight) - Math.max(y, 0);
        if (visible >= height * 0.5) {
          impressed.current = true;
          onImpression();
        }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [onImpression, scrollTick]);

  return <View ref={card} style={[styles.card, styles.houseCard]} accessible={false}>
    <View style={styles.houseCreative}>
      {ad.imageUrl ? <Image source={{ uri: ad.imageUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" accessible={false} /> : <>
        <View style={styles.houseOrb} />
        <BrandMark size={66} color={primary} />
      </>}
    </View>
    <View style={styles.copy}>
      <View style={styles.identityRow}>
        {ad.logoUrl ? <Image source={{ uri: ad.logoUrl }} style={styles.logo} resizeMode="contain" accessibilityLabel="Fridgie logo" /> : <BrandMark size={24} color={primary} />}
        <Text style={styles.disclosure}>{presentation.disclosure}</Text>
      </View>
      <Text style={styles.headline}>{ad.headline}</Text>
      <Text style={styles.body}>{ad.body}</Text>
      <GlassPressable style={styles.cta} onPress={() => onCta(ad.destinationUrl)} accessibilityRole="link" accessibilityLabel={`${ad.ctaLabel}, from Fridgie`}>
        <Text style={styles.ctaText}>{ad.ctaLabel}</Text>
        <Ionicons name="arrow-forward" size={16} color="#FFF" />
      </GlassPressable>
    </View>
    <AdControls presentation={presentation} onWhy={onWhy} onHide={onHide} onReport={onReport} />
  </View>;
}

function AdMobSponsoredCard({ sdk, nativeAd, onHide, onReport, onWhy }: {
  sdk: GoogleAdsSdk;
  nativeAd: GoogleNativeAd;
  onHide: () => void;
  onReport: () => void;
  onWhy: (explanation: string) => void;
}) {
  const brand = nativeAd.advertiser!;
  const presentation = sponsoredCardPresentation('paid', brand);
  const NativeAdView = sdk.NativeAdView;
  const NativeAsset = sdk.NativeAsset;
  const NativeMediaView = sdk.NativeMediaView;
  const Asset = sdk.NativeAssetType;
  return <View style={[styles.card, styles.paidCard]} accessible={false}>
    <NativeAdView nativeAd={nativeAd} style={styles.nativeBody}>
      <View style={styles.paidTop} accessible accessibilityLabel={presentation.disclosure}>
        <Text style={styles.disclosure}>Advertisement · </Text>
        <NativeAsset assetType={Asset.ADVERTISER}><Text style={styles.disclosure}>{brand}</Text></NativeAsset>
      </View>
      {!!nativeAd.mediaContent && <NativeMediaView style={styles.paidMedia} resizeMode="cover" accessible={false} />}
      <View style={styles.paidCreative}>
        <NativeAsset assetType={Asset.ICON}>
          <Image source={{ uri: nativeAd.icon!.url }} style={styles.paidIcon} resizeMode="cover" accessibilityLabel={`${brand} logo`} />
        </NativeAsset>
        <View style={styles.paidCopy}>
          <NativeAsset assetType={Asset.HEADLINE}><Text style={styles.headline}>{nativeAd.headline}</Text></NativeAsset>
          {!!nativeAd.body && <NativeAsset assetType={Asset.BODY}><Text style={styles.body} numberOfLines={3}>{nativeAd.body}</Text></NativeAsset>}
        </View>
      </View>
      <NativeAsset assetType={Asset.CALL_TO_ACTION}>
        <View style={styles.cta} accessible accessibilityRole="button" accessibilityLabel={`${nativeAd.callToAction}, advertisement from ${brand}`}>
          <Text style={styles.ctaText}>{nativeAd.callToAction}</Text>
          <Ionicons name="arrow-forward" size={16} color="#FFF" />
        </View>
      </NativeAsset>
    </NativeAdView>
    <AdControls presentation={presentation} onWhy={onWhy} onHide={onHide} onReport={onReport} />
  </View>;
}

export class HouseDiscoverAdProvider implements DiscoverAdProvider {
  readonly name = 'house' as const;

  async load({ config, session }: DiscoverAdProviderRequest): Promise<LoadedDiscoverAd | null> {
    const ad = config.houseAds.find(candidate => !session.isExcluded(`house:${candidate.id}`));
    if (!ad) return null;
    const id = `house:${ad.id}`;
    if (!session.accept(id, config.cadence.maxPerSession)) return null;
    return {
      id,
      provider: 'house',
      render: props => <HouseSponsoredCard ad={ad} scrollTick={props.scrollTick} onHide={props.onHide} onReport={props.onReport} onWhy={props.onWhy} onImpression={props.onHouseImpression} onCta={props.onHouseCta} />,
      destroy: () => {},
    };
  }
}

export class NoFillDiscoverAdProvider implements DiscoverAdProvider {
  readonly name = 'no-fill' as const;
  async load(): Promise<null> { return null; }
}

interface RuntimeAdMobConfig {
  enabled: boolean;
  production: boolean;
  unitId: string;
}

const GOOGLE_TEST_PUBLISHER = '3940256099942544';
const GOOGLE_TEST_NATIVE_UNITS = {
  android: `ca-app-pub-${GOOGLE_TEST_PUBLISHER}/2247696110`,
  ios: `ca-app-pub-${GOOGLE_TEST_PUBLISHER}/3986624511`,
} as const;
const NATIVE_UNIT = /^ca-app-pub-(\d{16})\/\d{10}$/;

export function readRuntimeAdMobConfig(): RuntimeAdMobConfig {
  const raw = Constants.expoConfig?.extra?.discoverAds as Record<string, unknown> | undefined;
  const production = raw?.production === true;
  const expectedTestUnit = Platform.OS === 'ios' ? GOOGLE_TEST_NATIVE_UNITS.ios : GOOGLE_TEST_NATIVE_UNITS.android;
  const unitId = Platform.OS === 'ios' ? raw?.iosNativeUnitId : raw?.androidNativeUnitId;
  const match = typeof unitId === 'string' ? NATIVE_UNIT.exec(unitId) : null;
  const safeUnit = !!match && (production ? match[1] !== GOOGLE_TEST_PUBLISHER : unitId === expectedTestUnit);
  return {
    enabled: raw?.admobEnabled === true && (Platform.OS === 'ios' || Platform.OS === 'android') && safeUnit,
    production,
    unitId: safeUnit ? unitId as string : '',
  };
}

let admobReady: Promise<{ sdk: GoogleAdsSdk; ready: boolean } | null> | null = null;

async function prepareAdMob(): Promise<{ sdk: GoogleAdsSdk; ready: boolean } | null> {
  if (admobReady) return admobReady;
  admobReady = (async () => {
    let sdk: GoogleAdsSdk;
    try {
      // Expo Go has no native module; a guarded dynamic load converts that to
      // no-fill instead of breaking Discover or startup.
      sdk = require('react-native-google-mobile-ads') as GoogleAdsSdk;
    } catch {
      return null;
    }
    try {
      // UMP is the consent boundary. No SDK initialization or request happens
      // unless the current consent state says ads may be requested.
      const consent = await sdk.AdsConsent.gatherConsent();
      if (!consent.canRequestAds) return { sdk, ready: false };
      await sdk.default().setRequestConfiguration({ maxAdContentRating: sdk.MaxAdContentRating.PG });
      await sdk.default().initialize();
      sdk.default().setAppMuted(true);
      return { sdk, ready: true };
    } catch {
      return { sdk, ready: false };
    }
  })();
  return admobReady;
}

export class AdMobNativeDiscoverAdProvider implements DiscoverAdProvider {
  readonly name = 'admob' as const;

  async load({ config, session, onMetric }: DiscoverAdProviderRequest): Promise<LoadedDiscoverAd | null> {
    const runtime = readRuntimeAdMobConfig();
    if (!runtime.enabled || !session.canLoad(config.cadence.maxPerSession)) return null;
    const prepared = await prepareAdMob();
    if (!prepared?.ready) return null;

    let nativeAd: GoogleNativeAd;
    try {
      nativeAd = await prepared.sdk.NativeAd.createForAdRequest(runtime.unitId, {
        requestNonPersonalizedAdsOnly: true,
        // No keywords, content URL, location, publisher ID, or user context.
        adChoicesPlacement: prepared.sdk.NativeAdChoicesPlacement.TOP_RIGHT,
        startVideoMuted: true,
      });
    } catch {
      return null;
    }

    // The pilot never renders video at all (muted autoplay is still autoplay),
    // and rejects incomplete ads rather than obscuring identity/disclosure.
    if (nativeAd.mediaContent?.hasVideoContent || !nativeAd.advertiser?.trim() || !nativeAd.icon?.url || !nativeAd.headline?.trim() || !nativeAd.callToAction?.trim()) {
      nativeAd.destroy();
      return null;
    }
    const dedupeId = `admob:${nativeAd.advertiser.trim().toLowerCase()}|${nativeAd.headline.trim().toLowerCase()}|${(nativeAd.body ?? '').trim().toLowerCase()}`;
    if (!session.accept(dedupeId, config.cadence.maxPerSession)) {
      nativeAd.destroy();
      return null;
    }

    nativeAd.addAdEventListener(prepared.sdk.NativeAdEventType.IMPRESSION, () => onMetric('impression', 'admob'));
    nativeAd.addAdEventListener(prepared.sdk.NativeAdEventType.CLICKED, () => onMetric('click', 'admob'));
    let destroyed = false;
    return {
      id: dedupeId,
      provider: 'admob',
      render: props => <AdMobSponsoredCard sdk={prepared.sdk} nativeAd={nativeAd} onHide={props.onHide} onReport={props.onReport} onWhy={props.onWhy} />,
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        nativeAd.destroy();
      },
    };
  }
}

export function providersFor(config: DiscoverAdvertisingConfig): DiscoverAdProvider[] {
  const providers: DiscoverAdProvider[] = config.providerOrder.map(name => name === 'admob'
    ? new AdMobNativeDiscoverAdProvider()
    : new HouseDiscoverAdProvider());
  providers.push(new NoFillDiscoverAdProvider());
  return providers;
}

export async function loadFirstDiscoverAd(
  providers: readonly DiscoverAdProvider[],
  request: Omit<DiscoverAdProviderRequest, 'onMetric'> & { onMetric?: DiscoverAdProviderRequest['onMetric'] },
): Promise<LoadedDiscoverAd | null> {
  const fullRequest = { ...request, onMetric: request.onMetric ?? track };
  for (const provider of providers) {
    const loaded = await provider.load(fullRequest);
    if (loaded) return loaded;
  }
  return null;
}

const styles = StyleSheet.create({
  card: {
    overflow: 'hidden',
    borderRadius: 27,
    borderWidth: 1,
    shadowColor: ink,
    shadowOpacity: 0.035,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 7 },
  },
  houseCard: { backgroundColor: '#EFF1E3', borderColor: '#D9DEC8' },
  paidCard: { backgroundColor: '#FCF9F1', borderColor: '#D8D0BC' },
  houseCreative: { height: 168, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: '#DDE9D9' },
  houseOrb: { position: 'absolute', width: 230, height: 230, borderRadius: 115, backgroundColor: 'rgba(255,255,255,0.54)', top: -118, right: -32 },
  copy: { paddingHorizontal: 18, paddingTop: 17 },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  logo: { width: 26, height: 26, borderRadius: 6 },
  disclosure: { color: '#715A26', fontSize: 10, lineHeight: 15, fontWeight: '700', letterSpacing: 0.35 },
  headline: { color: ink, fontSize: 21, lineHeight: 26, fontWeight: '700', letterSpacing: -0.55 },
  body: { color: inkMuted, fontSize: 13, lineHeight: 19, marginTop: 8 },
  cta: { alignSelf: 'flex-start', minHeight: 44, borderRadius: 22, backgroundColor: primary, paddingHorizontal: 17, marginTop: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  ctaText: { color: '#FFF', fontSize: 12, fontWeight: '700' },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 17, paddingHorizontal: 10, paddingVertical: 9, borderTopWidth: 1, borderTopColor: 'rgba(90,76,45,0.11)' },
  control: { minHeight: 40, borderRadius: 20, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 4 },
  controlText: { color: inkMuted, fontSize: 10, fontWeight: '600' },
  nativeBody: { paddingHorizontal: 18, paddingTop: 17, paddingRight: 42 },
  paidTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 15 },
  paidMedia: { width: '100%', minHeight: 164, maxHeight: 230, borderRadius: 18, marginBottom: 15, backgroundColor: '#EEE8D8' },
  paidCreative: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  paidIcon: { width: 68, height: 68, borderRadius: 14, backgroundColor: '#EEE8D8' },
  paidCopy: { flex: 1, minWidth: 0 },
});
