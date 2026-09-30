import { GlassPressable, GlassSurface } from '@/components/ui/Glass';
import { PRO_CONFIG, type ProBillingPeriod } from '@/constants/pro';
import { usePro } from '@/context/ProContext';
import {
  checkoutState,
  isSecureWebUrl,
  usageNotice,
} from '@/utils/pro';
import { canvas, hairline, ink, inkMuted, mint, peach, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const SOURCE_COPY: Record<string, { eyebrow: string; title: string; subtitle: string }> = {
  leftovers: {
    eyebrow: 'LEFTOVERS MODE',
    title: 'Turn what you have into dinner',
    subtitle: 'Photograph your fridge or pantry, correct what Fridgie sees, and get ideas shaped around it.',
  },
  nutrition: {
    eyebrow: 'WEEKLY ANALYSIS',
    title: 'See how your week adds up',
    subtitle: 'Set nutrition goals and follow estimated progress across the meals you plan and eat.',
  },
  quota: {
    eyebrow: 'YOUR WEEKLY ALLOWANCE',
    title: 'Keep the ideas coming',
    subtitle: 'Your free suggestions reset automatically. Pro gives frequent planners substantially more room.',
  },
};

const DEFAULT_COPY = {
  eyebrow: 'FRIDGIE PRO',
  title: 'A little more room in the kitchen',
  subtitle: 'Plan more often, make something from what you have, and understand the shape of your week.',
};

const BENEFITS = [
  {
    icon: 'sparkles-outline' as const,
    title: 'Higher AI limits',
    body: 'A substantially higher fair-use allowance for frequent meal planning.',
  },
  {
    icon: 'camera-outline' as const,
    title: 'Leftovers Mode',
    body: 'Use multiple fridge or pantry photos, then review ingredients before suggestions.',
  },
  {
    icon: 'analytics-outline' as const,
    title: 'Nutrition goals',
    body: 'Weekly progress for calories and protein, clearly labeled as estimates.',
  },
  {
    icon: 'leaf-outline' as const,
    title: 'Ad-free Fridgie',
    body: 'A calm experience, including when native Discover ads arrive later.',
  },
];

function billingPeriodCopy(period: ProBillingPeriod): string {
  return period === 'annual' ? 'Billed yearly' : 'Billed monthly';
}

export default function ProScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ source?: string }>();
  const copy = SOURCE_COPY[String(params.source ?? '')] ?? DEFAULT_COPY;
  const {
    isPro,
    isLoading,
    status,
    usage,
    statusError,
    requiresAccount,
    billingConfigured,
    isLoadingOffers,
    offers,
    billingError,
    verificationPending,
    isBillingStateLoading,
    retryBillingStateHydration,
    verificationPendingForDifferentAccount,
    action,
    refresh,
    reloadOffers,
    purchase,
    restore,
    clearBillingError,
  } = usePro();
  const [selectedOffer, setSelectedOffer] = useState<string | null>(null);

  useEffect(() => {
    if (selectedOffer && offers.some(offer => offer.id === selectedOffer)) return;
    setSelectedOffer(
      offers.find(offer => offer.period === 'annual')?.id ?? offers[0]?.id ?? null,
    );
  }, [offers, selectedOffer]);

  const selected = offers.find(offer => offer.id === selectedOffer) ?? null;
  const hasPrivacyUrl = isSecureWebUrl(PRO_CONFIG.privacyUrl);
  const hasTermsUrl = isSecureWebUrl(PRO_CONFIG.termsUrl);
  const legalConfigured = hasPrivacyUrl && hasTermsUrl;
  const checkout = checkoutState({
    requiresAccount,
    billingConfigured,
    legalConfigured,
    entitlementStatus: status?.entitlement.status,
    hasStatusError: !!statusError,
    hasSelectedOffer: !!selected,
  });
  const verificationAvailable = checkout !== 'verification-unavailable';
  const canPurchase = checkout === 'ready' && !verificationPending && !isBillingStateLoading;

  const usageCopy = useMemo(() => {
    if (!usage) return null;
    return usageNotice(usage, isPro);
  }, [isPro, usage]);

  const close = () => {
    if (params.source === 'nutrition' && isPro) {
      router.replace('/nutrition');
      return;
    }
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/list');
  };

  const buy = async () => {
    if (verificationPendingForDifferentAccount) {
      // The unresolved store transaction is intentionally pinned to its
      // original Firebase uid. Send this account to Profile so they can open
      // Settings, sign out, and return with the account that owns it.
      router.replace({ pathname: '/profile', params: { openSettings: 'pro-recovery' } });
      return;
    }
    if (requiresAccount) {
      // Replace this paywall with login so returning to /pro after auth does
      // not stack a second paywall on top of the first one.
      router.replace({
        pathname: '/login',
        params: {
          returnTo: 'pro',
          ...(typeof params.source === 'string' ? { proSource: params.source } : {}),
        },
      });
      return;
    }
    if (!selected) return;
    clearBillingError();
    const result = await purchase(selected.id);
    if (result === 'purchased') {
      AccessibilityInfo.announceForAccessibility('Fridgie Pro is active.');
    }
  };

  const restorePurchase = async () => {
    clearBillingError();
    const result = await restore();
    if (result === 'restored') {
      AccessibilityInfo.announceForAccessibility('Fridgie Pro purchase restored.');
    }
  };

  if (isPro && !isLoading && !statusError && !verificationPending) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.successGlow} />
        <View style={styles.successContent}>
          <View style={styles.successIcon}>
            <Ionicons name="sparkles" size={32} color={primary} />
          </View>
          <Text style={styles.eyebrow}>FRIDGIE PRO</Text>
          <Text style={styles.successTitle}>Pro is active</Text>
          <Text style={styles.successBody}>
            Leftovers Mode, weekly nutrition analysis, higher AI limits, and an ad-free experience are active.
          </Text>
          {usageCopy && (
            <GlassSurface
              style={[
                styles.activeUsageCard,
                usageCopy.level === 'low' && styles.usageLow,
                usageCopy.level === 'critical' && styles.usageCritical,
                usageCopy.level === 'exhausted' && styles.usageExhausted,
              ]}
              accessibilityRole={usageCopy.level === 'normal' ? 'text' : 'alert'}
              accessibilityLabel={`${usageCopy.title}. ${usageCopy.reset}.`}
              accessibilityLiveRegion={usageCopy.level === 'normal' ? 'none' : 'polite'}
            >
              <Text style={styles.activeUsageTitle}>{usageCopy.title}</Text>
              <Text style={styles.activeUsageReset}>{usageCopy.reset}</Text>
            </GlassSurface>
          )}
          <GlassPressable style={styles.primaryButton} onPress={close}>
            <Text style={styles.primaryButtonText}>Done</Text>
          </GlassPressable>
          <GlassPressable
            style={styles.textButton}
            onPress={restorePurchase}
            disabled={action !== null || !billingConfigured}
          >
            <Text style={styles.textButtonLabel}>
              {action === 'restoring' ? 'Restoring…' : 'Restore Purchases'}
            </Text>
          </GlassPressable>
          {!!billingError && <Text style={styles.errorText}>{billingError}</Text>}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View pointerEvents="none" style={styles.topGlow} />
      <View style={styles.header}>
        <View style={styles.headerSpacer} />
        <GlassPressable
          style={styles.closeButton}
          onPress={close}
          accessibilityLabel="Close Fridgie Pro"
        >
          <Ionicons name="close" size={23} color={ink} />
        </GlassPressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.heroIcon}>
          <Ionicons name="sparkles" size={27} color={primary} />
        </View>
        <Text style={styles.eyebrow}>{copy.eyebrow}</Text>
        <Text style={styles.title}>{copy.title}</Text>
        <Text style={styles.subtitle}>{copy.subtitle}</Text>

        {isLoading ? (
          <GlassSurface style={styles.usageCard} accessibilityLabel="Loading AI suggestion allowance">
            <ActivityIndicator color={primary} />
            <Text style={styles.usageLoading}>Checking this week’s allowance…</Text>
          </GlassSurface>
        ) : usageCopy ? (
          <GlassSurface
            style={[
              styles.usageCard,
              usageCopy.level === 'low' && styles.usageLow,
              usageCopy.level === 'critical' && styles.usageCritical,
              usageCopy.level === 'exhausted' && styles.usageExhausted,
            ]}
            accessibilityRole={usageCopy.level === 'normal' ? 'text' : 'alert'}
            accessibilityLabel={`${usageCopy.title}. ${usageCopy.reset}.`}
            accessibilityLiveRegion={usageCopy.level === 'normal' ? 'none' : 'polite'}
          >
            <View style={styles.usageIcon}>
              <Ionicons
                name={usageCopy.level === 'normal' ? 'time-outline' : 'alert-circle-outline'}
                size={20}
                color={usageCopy.level === 'normal' ? primary : '#A75532'}
              />
            </View>
            <View style={styles.usageCopy}>
              <Text style={styles.usageTitle}>{usageCopy.title}</Text>
              <Text style={styles.usageReset}>{usageCopy.reset}</Text>
            </View>
          </GlassSurface>
        ) : null}

        {!!statusError && (
          <View style={styles.inlineError} accessibilityRole="alert">
            <Text style={styles.inlineErrorText}>{statusError}</Text>
            <GlassPressable style={styles.retryButton} onPress={refresh}>
              <Text style={styles.retryButtonText}>Try again</Text>
            </GlassPressable>
          </View>
        )}

        <GlassSurface style={styles.benefitsCard}>
          {BENEFITS.map((benefit, index) => (
            <View key={benefit.title}>
              <View style={styles.benefitRow}>
                <View style={styles.benefitIcon}>
                  <Ionicons name={benefit.icon} size={20} color={primary} />
                </View>
                <View style={styles.benefitCopy}>
                  <Text style={styles.benefitTitle}>{benefit.title}</Text>
                  <Text style={styles.benefitBody}>{benefit.body}</Text>
                </View>
              </View>
              {index < BENEFITS.length - 1 && <View style={styles.divider} />}
            </View>
          ))}
        </GlassSurface>

        <View style={styles.freePromise}>
          <Ionicons name="heart-outline" size={18} color={primary} />
          <Text style={styles.freePromiseText}>
            Recipes, grocery lists, cookbook, sharing, cooking, and dietary or allergen controls stay free.
          </Text>
        </View>

        <Text style={styles.planHeading}>Choose your plan</Text>
        {isLoadingOffers ? (
          <View style={styles.offerLoading}>
            <ActivityIndicator color={primary} />
            <Text style={styles.offerLoadingText}>Loading local store prices…</Text>
          </View>
        ) : offers.length ? (
          <View style={styles.offers}>
            {offers.map(offer => {
              const selectedNow = offer.id === selectedOffer;
              return (
                <GlassPressable
                  key={offer.id}
                  style={[styles.offerCard, selectedNow && styles.offerCardSelected]}
                  onPress={() => setSelectedOffer(offer.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selectedNow }}
                  accessibilityLabel={`${offer.title}, ${offer.price}, ${billingPeriodCopy(offer.period)}`}
                >
                  <View style={[styles.radio, selectedNow && styles.radioSelected]}>
                    {selectedNow && <View style={styles.radioDot} />}
                  </View>
                  <View style={styles.offerCopy}>
                    <View style={styles.offerTitleRow}>
                      <Text style={styles.offerTitle}>{offer.title}</Text>
                      {offer.period === 'annual' && (
                        <View style={styles.valuePill}><Text style={styles.valuePillText}>BEST VALUE</Text></View>
                      )}
                    </View>
                    <Text style={styles.offerCadence}>{billingPeriodCopy(offer.period)}</Text>
                  </View>
                  <View style={styles.offerPriceBlock}>
                    <Text style={styles.offerPrice}>{offer.price}</Text>
                    {offer.period === 'annual' && offer.pricePerMonth && (
                      <Text style={styles.offerMonthly}>{offer.pricePerMonth}/mo</Text>
                    )}
                  </View>
                </GlassPressable>
              );
            })}
          </View>
        ) : (
          <View style={styles.fallbackPlans}>
            <Text style={styles.fallbackLabel}>Expected launch pricing</Text>
            <View style={styles.fallbackRow}>
              <Text style={styles.fallbackPlan}>Monthly</Text>
              <Text style={styles.fallbackPrice}>{PRO_CONFIG.fallbackPriceCopy.monthly}</Text>
            </View>
            <View style={styles.fallbackRow}>
              <Text style={styles.fallbackPlan}>Yearly</Text>
              <Text style={styles.fallbackPrice}>{PRO_CONFIG.fallbackPriceCopy.annual}</Text>
            </View>
          </View>
        )}

        {!billingConfigured && (
          <Text style={styles.setupNote}>
            Purchases aren’t enabled in this build yet. No charge can be made.
          </Text>
        )}
        {requiresAccount && (
          <Text style={styles.setupNote}>
            Sign in first so Fridgie Pro and your weekly allowance follow you across devices.
          </Text>
        )}
        {!verificationAvailable && (
          <Text style={styles.setupNote}>
            Secure purchase verification is not available yet, so checkout is disabled.
          </Text>
        )}
        {billingConfigured && !legalConfigured && (
          <Text style={styles.setupNote}>
            Checkout is disabled until the production Privacy Policy and Terms links are configured.
          </Text>
        )}
        {verificationPending && (
          <Text style={styles.setupNote} accessibilityRole="alert">
            {requiresAccount
              ? 'Purchase verification is pending. Don’t purchase again. Sign in to the account that started it, then use Restore Purchases.'
              : verificationPendingForDifferentAccount
                ? 'This pending purchase belongs to another Fridgie account. Go to Profile, open Settings, sign out, then return with the account that started it.'
                : 'Purchase verification is pending. Don’t purchase again. Use Restore Purchases to finish verification.'}
          </Text>
        )}
        {isBillingStateLoading && (
          <Text style={styles.setupNote}>Checking for an earlier store purchase…</Text>
        )}
        {!!billingError && (
          <View style={styles.inlineError} accessibilityRole="alert">
            <Text style={styles.inlineErrorText}>{billingError}</Text>
            {isBillingStateLoading ? (
              <GlassPressable
                style={styles.retryButton}
                onPress={() => { void retryBillingStateHydration(); }}
              >
                <Text style={styles.retryButtonText}>Retry safety check</Text>
              </GlassPressable>
            ) : billingConfigured && !offers.length ? (
              <GlassPressable style={styles.retryButton} onPress={reloadOffers}>
                <Text style={styles.retryButtonText}>Reload prices</Text>
              </GlassPressable>
            ) : null}
          </View>
        )}

        <GlassPressable
          style={styles.primaryButton}
          onPress={buy}
          disabled={
            action !== null
            || isBillingStateLoading
            || (requiresAccount ? !billingConfigured : false)
            || (!requiresAccount && !verificationPendingForDifferentAccount && !canPurchase)
          }
          accessibilityLabel={isBillingStateLoading
            ? 'Checking purchase recovery status'
            : requiresAccount
            ? (verificationPending ? 'Sign in to finish purchase verification' : 'Sign in to get Fridgie Pro')
            : verificationPendingForDifferentAccount
              ? 'Go to Profile to switch Fridgie accounts'
              : verificationPending
                ? 'Purchase verification pending. Use Restore Purchases.'
                : selected
                  ? `Continue with ${selected.title} Fridgie Pro`
                  : 'Choose a Fridgie Pro plan'}
        >
          {action === 'purchasing' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonText}>
              {isBillingStateLoading
                ? 'Checking purchase status…'
                : requiresAccount
                ? (verificationPending ? 'Sign in to finish verification' : 'Sign in to get Pro')
                : verificationPendingForDifferentAccount
                  ? 'Go to Profile'
                  : verificationPending
                    ? 'Purchase verification pending'
                    : !billingConfigured
                  ? 'Purchases unavailable in this build'
                  : checkout === 'legal-unconfigured'
                    ? 'Checkout setup incomplete'
                    : 'Continue with Fridgie Pro'}
            </Text>
          )}
        </GlassPressable>
        <GlassPressable
          style={styles.textButton}
          onPress={restorePurchase}
          disabled={action !== null || isBillingStateLoading || !billingConfigured || requiresAccount}
        >
          <Text style={styles.textButtonLabel}>
            {action === 'restoring' ? 'Restoring…' : 'Restore Purchases'}
          </Text>
        </GlassPressable>

        <Text style={styles.renewalCopy}>
          Payment is confirmed by your app store. Subscriptions renew automatically until canceled in store settings. Localized pricing and taxes may vary.
        </Text>
        {(hasPrivacyUrl || hasTermsUrl) && (
          <View style={styles.legalRow}>
            {hasPrivacyUrl && (
              <GlassPressable onPress={() => Linking.openURL(PRO_CONFIG.privacyUrl)} style={styles.legalButton}>
                <Text style={styles.legalText}>Privacy</Text>
              </GlassPressable>
            )}
            {hasTermsUrl && (
              <GlassPressable onPress={() => Linking.openURL(PRO_CONFIG.termsUrl)} style={styles.legalButton}>
                <Text style={styles.legalText}>Terms</Text>
              </GlassPressable>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: canvas },
  topGlow: {
    position: 'absolute', width: 420, height: 420, borderRadius: 210,
    backgroundColor: 'rgba(208,232,213,0.68)', top: -275, alignSelf: 'center',
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 18, paddingTop: 4 },
  headerSpacer: { flex: 1 },
  closeButton: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.72)',
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#fff',
  },
  scrollContent: { paddingHorizontal: 22, paddingBottom: 34, alignItems: 'center' },
  heroIcon: {
    width: 64, height: 64, borderRadius: 23, backgroundColor: mint,
    alignItems: 'center', justifyContent: 'center', marginTop: 2, marginBottom: 18,
  },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.8, color: primary, textAlign: 'center' },
  title: { fontSize: 34, lineHeight: 39, letterSpacing: -1.3, fontWeight: '700', color: ink, textAlign: 'center', marginTop: 9 },
  subtitle: { fontSize: 15, lineHeight: 22, color: inkMuted, textAlign: 'center', marginTop: 11, maxWidth: 430 },
  usageCard: {
    width: '100%', marginTop: 22, borderRadius: 20, padding: 15,
    flexDirection: 'row', alignItems: 'center', minHeight: 68,
  },
  usageLow: { backgroundColor: 'rgba(252,241,220,0.9)', borderColor: 'rgba(214,162,84,0.3)' },
  usageCritical: { backgroundColor: 'rgba(250,229,214,0.92)', borderColor: 'rgba(196,111,75,0.32)' },
  usageExhausted: { backgroundColor: 'rgba(247,222,211,0.94)', borderColor: 'rgba(174,83,55,0.35)' },
  usageIcon: { width: 38, height: 38, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.65)', alignItems: 'center', justifyContent: 'center' },
  usageCopy: { flex: 1, marginLeft: 12 },
  usageTitle: { color: ink, fontSize: 14, fontWeight: '700' },
  usageReset: { color: inkMuted, fontSize: 12, marginTop: 4 },
  usageLoading: { marginLeft: 12, color: inkMuted, fontSize: 13 },
  benefitsCard: { width: '100%', marginTop: 18, paddingHorizontal: 16, paddingVertical: 5, borderRadius: 26 },
  benefitRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  benefitIcon: { width: 43, height: 43, borderRadius: 16, backgroundColor: mint, alignItems: 'center', justifyContent: 'center' },
  benefitCopy: { flex: 1, marginLeft: 13 },
  benefitTitle: { color: ink, fontSize: 15, fontWeight: '700', marginBottom: 3 },
  benefitBody: { color: inkMuted, fontSize: 12, lineHeight: 17 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: hairline, marginLeft: 56 },
  freePromise: { width: '100%', flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingHorizontal: 7, marginTop: 17 },
  freePromiseText: { color: inkMuted, fontSize: 12, lineHeight: 18, flex: 1 },
  planHeading: { width: '100%', color: ink, fontSize: 21, fontWeight: '700', letterSpacing: -0.5, marginTop: 29, marginBottom: 12 },
  offers: { width: '100%', gap: 10 },
  offerCard: {
    width: '100%', minHeight: 78, padding: 15, borderRadius: 21, borderWidth: 1,
    borderColor: hairline, backgroundColor: 'rgba(255,255,255,0.72)', flexDirection: 'row', alignItems: 'center',
  },
  offerCardSelected: { borderWidth: 2, borderColor: primary, padding: 14, backgroundColor: 'rgba(244,250,244,0.95)' },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: '#9CAD9F', alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: primary },
  radioDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: primary },
  offerCopy: { flex: 1, marginLeft: 12 },
  offerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  offerTitle: { color: ink, fontSize: 16, fontWeight: '700' },
  valuePill: { borderRadius: 8, backgroundColor: peach, paddingHorizontal: 7, paddingVertical: 3 },
  valuePillText: { color: '#5D3428', fontSize: 8, fontWeight: '900', letterSpacing: 0.6 },
  offerCadence: { color: inkMuted, fontSize: 11, marginTop: 4 },
  offerPriceBlock: { alignItems: 'flex-end', marginLeft: 8 },
  offerPrice: { color: ink, fontSize: 16, fontWeight: '700' },
  offerMonthly: { color: inkMuted, fontSize: 10, marginTop: 3 },
  offerLoading: { width: '100%', minHeight: 88, alignItems: 'center', justifyContent: 'center', gap: 9 },
  offerLoadingText: { color: inkMuted, fontSize: 12 },
  fallbackPlans: { width: '100%', backgroundColor: 'rgba(255,255,255,0.64)', borderRadius: 21, padding: 16, gap: 12 },
  fallbackLabel: { color: inkMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase' },
  fallbackRow: { flexDirection: 'row', justifyContent: 'space-between' },
  fallbackPlan: { color: ink, fontSize: 14, fontWeight: '600' },
  fallbackPrice: { color: ink, fontSize: 14, fontWeight: '700' },
  setupNote: { color: '#8A563D', fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 11, paddingHorizontal: 12 },
  primaryButton: { width: '100%', minHeight: 56, borderRadius: 20, backgroundColor: primary, alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  textButton: { minHeight: 48, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', marginTop: 3 },
  textButtonLabel: { color: primary, fontSize: 14, fontWeight: '700' },
  renewalCopy: { color: inkMuted, fontSize: 10, lineHeight: 15, textAlign: 'center', paddingHorizontal: 12, marginTop: 2 },
  legalRow: { flexDirection: 'row', marginTop: 5 },
  legalButton: { paddingHorizontal: 12, paddingVertical: 10 },
  legalText: { color: inkMuted, textDecorationLine: 'underline', fontSize: 11 },
  inlineError: { width: '100%', backgroundColor: '#FAE7DF', borderRadius: 16, padding: 13, marginTop: 12, alignItems: 'center' },
  inlineErrorText: { color: '#813E2B', fontSize: 12, lineHeight: 17, textAlign: 'center' },
  errorText: { color: '#813E2B', fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 4 },
  retryButton: { paddingHorizontal: 14, paddingVertical: 8, marginTop: 4 },
  retryButtonText: { color: '#813E2B', fontSize: 12, fontWeight: '700' },
  successGlow: {
    position: 'absolute', width: 460, height: 460, borderRadius: 230,
    backgroundColor: 'rgba(208,232,213,0.75)', top: -190, alignSelf: 'center',
  },
  successContent: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 28 },
  successIcon: { width: 78, height: 78, borderRadius: 28, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  successTitle: { color: ink, fontSize: 36, fontWeight: '700', letterSpacing: -1.2, marginTop: 9, textAlign: 'center' },
  successBody: { color: inkMuted, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 11, maxWidth: 430 },
  activeUsageCard: { width: '100%', borderRadius: 20, padding: 16, alignItems: 'center', marginTop: 24 },
  activeUsageTitle: { color: ink, fontSize: 14, fontWeight: '700' },
  activeUsageReset: { color: inkMuted, fontSize: 12, marginTop: 5 },
});
