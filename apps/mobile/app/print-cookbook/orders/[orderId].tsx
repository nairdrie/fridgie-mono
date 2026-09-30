import { AmbientBackground, GlassPressable, GlassSurface } from '@/components/ui/Glass';
import type { CookbookPrintOrder } from '@/types/types';
import {
  cancelCookbookPrintOrder,
  getCookbookPrintOrder,
  reprintCookbookPrintOrder,
  retryCookbookPrintOrder,
} from '@/utils/api';
import {
  canCancelPrintOrder,
  canReprintCookbookOrder,
  canRetryPrintOrder,
  formatPrintDate,
  formatPrintMoney,
  isPrintOrderSettled,
  printFulfillmentLabel,
  printOrderTone,
  printPaymentLabel,
} from '@/utils/printOrders';
import { hairline, ink, inkFaint, inkMuted, mint, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type OrderAction = 'retry' | 'cancel' | 'reprint';

const toneStyles = {
  green: { backgroundColor: '#E3EFE5', color: primary, icon: 'checkmark-circle' as const },
  gold: { backgroundColor: '#F2E9D9', color: '#7A5A31', icon: 'time' as const },
  red: { backgroundColor: '#F5E2DF', color: '#974B45', icon: 'alert-circle' as const },
  quiet: { backgroundColor: '#E8EBE7', color: inkMuted, icon: 'remove-circle' as const },
};

function DetailRow({ label, value }: { label: string; value: string }) {
  return <View style={styles.detailRow}><Text style={styles.detailLabel}>{label}</Text><Text style={styles.detailValue}>{value}</Text></View>;
}

export default function CookbookPrintOrderDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ orderId?: string | string[]; confirmed?: string | string[] }>();
  const orderId = Array.isArray(params.orderId) ? params.orderId[0] : params.orderId;
  const confirmed = (Array.isArray(params.confirmed) ? params.confirmed[0] : params.confirmed) === '1';
  const [order, setOrder] = useState<CookbookPrintOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<OrderAction | null>(null);

  const load = useCallback(async (refresh = false) => {
    if (!orderId) {
      setError('This order link is incomplete.');
      setLoading(false);
      return;
    }
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const result = await getCookbookPrintOrder(orderId);
      setOrder(result);
      setError(null);
    } catch (caught: any) {
      setError(caught?.message || 'Could not refresh this order.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [orderId]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  useEffect(() => {
    if (!order || isPrintOrderSettled(order)) return;
    const interval = setInterval(() => { void load(); }, 12_000);
    return () => clearInterval(interval);
  }, [load, order]);

  const runAction = useCallback(async (action: OrderAction) => {
    if (!order) return;
    setActing(action);
    setError(null);
    try {
      const updated = action === 'retry'
        ? await retryCookbookPrintOrder(order.id)
        : action === 'cancel'
          ? await cancelCookbookPrintOrder(order.id)
          : await reprintCookbookPrintOrder(order.id);
      setOrder(updated);
    } catch (caught: any) {
      setError(caught?.message || `Could not ${action} this order.`);
    } finally {
      setActing(null);
    }
  }, [order]);

  const confirmCancel = useCallback(() => {
    Alert.alert(
      'Cancel this order?',
      'The server will check whether the printer can still stop it. Any refund status will appear here.',
      [
        { text: 'Keep order', style: 'cancel' },
        { text: 'Request cancellation', style: 'destructive', onPress: () => { void runAction('cancel'); } },
      ],
    );
  }, [runAction]);

  const confirmReprint = useCallback(() => {
    Alert.alert(
      'Request a replacement?',
      'Fridgie support will review the original shipment first. If approved, the printer receives the exact cookbook files you purchased.',
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Request review', onPress: () => { void runAction('reprint'); } },
      ],
    );
  }, [runAction]);

  const openTracking = useCallback(async () => {
    const url = order?.tracking?.trackingUrl;
    if (!url) return;
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('Could not open tracking', 'Try the carrier tracking number shown on this page.');
    }
  }, [order?.tracking?.trackingUrl]);

  if (loading && !order) {
    return <AmbientBackground><StatusBar style="dark" /><SafeAreaView style={styles.screen}><View style={styles.centered}><ActivityIndicator size="large" color={primary} /><Text style={styles.loadingText}>Checking the live order…</Text></View></SafeAreaView></AmbientBackground>;
  }

  if (!order) {
    return <AmbientBackground><StatusBar style="dark" /><SafeAreaView style={styles.screen}><View style={styles.header}><GlassPressable style={styles.headerButton} onPress={() => router.back()} accessibilityLabel="Back"><Ionicons name="chevron-back" size={23} color={ink} /></GlassPressable></View><View style={styles.centered}><View style={styles.largeIcon}><Ionicons name="cloud-offline-outline" size={34} color={primary} /></View><Text style={styles.emptyTitle}>This order is out of reach</Text><Text style={styles.emptyText}>{error || 'It may have moved or still be syncing.'}</Text><GlassPressable style={styles.primaryButton} onPress={() => { void load(); }}><Text style={styles.primaryButtonText}>Try again</Text></GlassPressable><GlassPressable style={styles.textButton} onPress={() => router.replace('/print-cookbook/orders' as any)}><Text style={styles.textButtonText}>All orders</Text></GlassPressable></View></SafeAreaView></AmbientBackground>;
  }

  const tone = toneStyles[printOrderTone(order)];
  const isPaid = order.paymentStatus === 'paid';
  const showRetry = canRetryPrintOrder(order);
  const showCancel = canCancelPrintOrder(order);
  const showReprint = canReprintCookbookOrder(order);

  return (
    <AmbientBackground>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <GlassPressable style={styles.headerButton} onPress={() => router.back()} accessibilityLabel="Back to orders"><Ionicons name="chevron-back" size={23} color={ink} /></GlassPressable>
          <View style={styles.headerCopy}><Text style={styles.eyebrow}>PRINT ORDER</Text><Text style={styles.headerTitle} numberOfLines={1}>{order.title}</Text></View>
          <GlassPressable style={styles.headerButton} onPress={() => { void load(true); }} accessibilityLabel="Refresh order status" disabled={refreshing}><Ionicons name="refresh-outline" size={21} color={ink} /></GlassPressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void load(true); }} tintColor={primary} />}
        >
          {confirmed && (
            <View style={[styles.confirmation, { backgroundColor: isPaid ? '#E3EFE5' : '#F2E9D9' }]}>
              <Ionicons name={isPaid ? 'checkmark-circle' : 'time'} size={24} color={isPaid ? primary : '#7A5A31'} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.confirmationTitle, { color: isPaid ? primary : '#6F532F' }]}>{isPaid ? 'Payment received' : 'Payment submitted'}</Text>
                <Text style={styles.confirmationText}>{isPaid ? 'Your order is moving into production.' : 'Stripe and the printer are still confirming it. This page updates from the server.'}</Text>
              </View>
            </View>
          )}

          <GlassSurface style={styles.heroCard} intensity={52}>
            <View style={[styles.heroIcon, { backgroundColor: tone.backgroundColor }]}><Ionicons name={tone.icon} size={31} color={tone.color} /></View>
            <Text style={styles.heroEyebrow}>CURRENT STATUS</Text>
            <Text style={[styles.heroStatus, { color: tone.color }]}>{printFulfillmentLabel(order.fulfillmentStatus)}</Text>
            <Text style={styles.heroDetail}>Updated {formatPrintDate(order.updatedAt, true)}</Text>
            <View style={styles.progressTrack}><View style={[styles.progressFill, { backgroundColor: tone.color, width: order.fulfillmentStatus === 'delivered' ? '100%' : order.fulfillmentStatus === 'shipped' ? '82%' : order.fulfillmentStatus === 'in-production' ? '60%' : order.fulfillmentStatus === 'submitted' ? '40%' : '20%' }]} /></View>
            {!isPrintOrderSettled(order) && <View style={styles.liveRow}><View style={styles.liveDot} /><Text style={styles.liveText}>Live status · refreshes while this page is open</Text></View>}
          </GlassSurface>

          {!!order.lastFailure && (
            <View style={styles.failureCard}>
              <Ionicons name="alert-circle-outline" size={22} color="#974B45" />
              <View style={{ flex: 1 }}><Text style={styles.failureTitle}>{order.lastFailure.retryable ? 'This order can be retried' : 'This order needs help'}</Text><Text style={styles.failureText}>{order.lastFailure.message}</Text><Text style={styles.failureCode}>Reference {order.lastFailure.code}</Text></View>
            </View>
          )}

          <GlassSurface style={styles.sectionCard} intensity={44}>
            <Text style={styles.sectionTitle}>Order details</Text>
            <DetailRow label="Format" value={order.sku === 'matte-hardcover' ? 'Matte hardcover' : 'Matte softcover'} />
            <DetailRow label="Quantity" value="1 copy" />
            <DetailRow label="Payment" value={printPaymentLabel(order.paymentStatus)} />
            <DetailRow label="Total" value={formatPrintMoney(order.total)} />
            <DetailRow label="Printer" value={order.providerName} />
            {!!order.providerStatus && <DetailRow label="Printer status" value={order.providerStatus} />}
            <DetailRow label="Ordered" value={formatPrintDate(order.createdAt, true)} />
            <DetailRow label="Order number" value={order.id} />
          </GlassSurface>

          {!!order.tracking && (
            <GlassSurface style={styles.trackingCard} intensity={44}>
              <View style={styles.trackingIcon}><Ionicons name="cube-outline" size={24} color={primary} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionTitle}>Delivery</Text>
                {!!order.tracking.carrier && <Text style={styles.trackingLine}>{order.tracking.carrier}</Text>}
                {!!order.tracking.trackingNumber && <Text style={styles.trackingNumber} selectable>{order.tracking.trackingNumber}</Text>}
                {!!order.tracking.estimatedDelivery && <Text style={styles.trackingEstimate}>Estimated {order.tracking.estimatedDelivery}</Text>}
                {!!order.tracking.trackingUrl && <GlassPressable style={styles.trackingButton} onPress={openTracking}><Text style={styles.trackingButtonText}>Open carrier tracking</Text><Ionicons name="open-outline" size={15} color={primary} /></GlassPressable>}
              </View>
            </GlassSurface>
          )}

          {(showRetry || showCancel || showReprint) && <View style={styles.actions}>
            {showRetry && <GlassPressable style={styles.primaryButton} onPress={() => { void runAction('retry'); }} disabled={!!acting}>{acting === 'retry' ? <ActivityIndicator color="#fff" /> : <><Ionicons name="refresh-outline" size={17} color="#fff" /><Text style={styles.primaryButtonText}>Retry with printer</Text></>}</GlassPressable>}
            {showReprint && <GlassPressable style={styles.primaryButton} onPress={confirmReprint} disabled={!!acting}>{acting === 'reprint' ? <ActivityIndicator color="#fff" /> : <><Ionicons name="copy-outline" size={17} color="#fff" /><Text style={styles.primaryButtonText}>Request a replacement</Text></>}</GlassPressable>}
            {showCancel && <GlassPressable style={styles.cancelButton} onPress={confirmCancel} disabled={!!acting}>{acting === 'cancel' ? <ActivityIndicator color="#974B45" /> : <Text style={styles.cancelText}>Request cancellation</Text>}</GlassPressable>}
          </View>}

          {!!error && <GlassPressable style={styles.errorCard} onPress={() => { void load(true); }}><Ionicons name="cloud-offline-outline" size={19} color="#974B45" /><Text style={styles.errorText}>{error} Tap to refresh.</Text></GlassPressable>}
          <Text style={styles.providerNote}>Fridgie shows the status returned by {order.providerName}. Production and carrier timing can change after an order is accepted.</Text>
        </ScrollView>
      </SafeAreaView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14 },
  headerButton: { width: 43, height: 43, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.76)', borderWidth: 1, borderColor: '#fff' },
  headerCopy: { flex: 1 },
  eyebrow: { color: inkMuted, fontSize: 9, letterSpacing: 1.45, fontWeight: '800' },
  headerTitle: { color: ink, fontSize: 21, lineHeight: 27, letterSpacing: -0.5, fontWeight: '700' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 13, paddingHorizontal: 34 },
  loadingText: { color: inkMuted, fontSize: 13 },
  largeIcon: { width: 76, height: 76, borderRadius: 27, alignItems: 'center', justifyContent: 'center', backgroundColor: mint },
  emptyTitle: { color: ink, fontSize: 22, lineHeight: 28, fontWeight: '700', textAlign: 'center' },
  emptyText: { color: inkMuted, fontSize: 13, lineHeight: 20, textAlign: 'center', maxWidth: 330 },
  content: { paddingHorizontal: 20, paddingTop: 5, paddingBottom: 42 },
  confirmation: { flexDirection: 'row', gap: 10, borderRadius: 20, padding: 14, marginBottom: 13 },
  confirmationTitle: { fontSize: 14, fontWeight: '800' },
  confirmationText: { color: inkMuted, fontSize: 11, lineHeight: 17, marginTop: 3 },
  heroCard: { alignItems: 'center', borderRadius: 30, padding: 22, marginBottom: 13 },
  heroIcon: { width: 61, height: 61, borderRadius: 23, alignItems: 'center', justifyContent: 'center', marginBottom: 13 },
  heroEyebrow: { color: inkFaint, fontSize: 9, letterSpacing: 1.35, fontWeight: '800' },
  heroStatus: { fontSize: 25, lineHeight: 31, letterSpacing: -0.7, fontWeight: '800', marginTop: 2, textAlign: 'center' },
  heroDetail: { color: inkMuted, fontSize: 10, marginTop: 5 },
  progressTrack: { width: '100%', height: 6, borderRadius: 3, backgroundColor: '#E4E9E1', marginTop: 18, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 11 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: primary },
  liveText: { color: inkFaint, fontSize: 9, fontWeight: '600' },
  failureCard: { flexDirection: 'row', gap: 10, padding: 15, borderRadius: 21, backgroundColor: '#F5E2DF', marginBottom: 13 },
  failureTitle: { color: '#85433D', fontSize: 13, fontWeight: '800' },
  failureText: { color: '#895B57', fontSize: 11, lineHeight: 17, marginTop: 4 },
  failureCode: { color: '#A87974', fontSize: 9, marginTop: 6 },
  sectionCard: { borderRadius: 27, padding: 18, marginBottom: 13 },
  sectionTitle: { color: ink, fontSize: 18, lineHeight: 23, fontWeight: '700', letterSpacing: -0.4, marginBottom: 10 },
  detailRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18, minHeight: 37, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hairline },
  detailLabel: { color: inkMuted, fontSize: 11 },
  detailValue: { flex: 1, color: ink, fontSize: 11, fontWeight: '700', textAlign: 'right' },
  trackingCard: { borderRadius: 27, padding: 17, flexDirection: 'row', gap: 13, marginBottom: 13 },
  trackingIcon: { width: 47, height: 47, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: mint },
  trackingLine: { color: inkMuted, fontSize: 11 },
  trackingNumber: { color: ink, fontSize: 13, lineHeight: 19, fontWeight: '800', marginTop: 3 },
  trackingEstimate: { color: inkMuted, fontSize: 10, marginTop: 5 },
  trackingButton: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 35, marginTop: 8 },
  trackingButtonText: { color: primary, fontSize: 11, fontWeight: '800' },
  actions: { gap: 9, marginTop: 3, marginBottom: 13 },
  primaryButton: { minHeight: 50, borderRadius: 21, backgroundColor: primary, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  primaryButtonText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  cancelButton: { minHeight: 48, borderRadius: 20, backgroundColor: '#F5E2DF', alignItems: 'center', justifyContent: 'center' },
  cancelText: { color: '#974B45', fontSize: 13, fontWeight: '800' },
  textButton: { padding: 12 },
  textButtonText: { color: primary, fontSize: 13, fontWeight: '800' },
  errorCard: { flexDirection: 'row', gap: 8, alignItems: 'center', borderRadius: 18, padding: 13, backgroundColor: '#F5E2DF', marginBottom: 13 },
  errorText: { flex: 1, color: '#85433D', fontSize: 11, lineHeight: 16 },
  providerNote: { color: inkFaint, fontSize: 9, lineHeight: 15, textAlign: 'center', paddingHorizontal: 18, marginTop: 3 },
});
