import { AmbientBackground, GlassPressable } from '@/components/ui/Glass';
import type { CookbookPrintOrder } from '@/types/types';
import { getCookbookPrintOrders } from '@/utils/api';
import {
  formatPrintDate,
  formatPrintMoney,
  printFulfillmentLabel,
  printOrderTone,
  printPaymentLabel,
} from '@/utils/printOrders';
import { ink, inkFaint, inkMuted, mint, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const toneStyles = {
  green: { backgroundColor: '#E3EFE5', color: primary },
  gold: { backgroundColor: '#F2E9D9', color: '#7A5A31' },
  red: { backgroundColor: '#F5E2DF', color: '#974B45' },
  quiet: { backgroundColor: '#E8EBE7', color: inkMuted },
};

function OrderCard({ order, onPress }: { order: CookbookPrintOrder; onPress: () => void }) {
  const tone = toneStyles[printOrderTone(order)];
  return (
    <GlassPressable
      style={styles.orderCard}
      onPress={onPress}
      accessibilityLabel={`${order.title}, ${printFulfillmentLabel(order.fulfillmentStatus)}, ${formatPrintMoney(order.total)}`}
    >
      <View style={styles.bookMark}>
        <View style={styles.bookSpine} />
        <Ionicons name={order.sku === 'matte-hardcover' ? 'albums-outline' : 'book-outline'} size={25} color={primary} />
      </View>
      <View style={styles.orderCopy}>
        <View style={styles.orderTitleRow}>
          <Text style={styles.orderTitle} numberOfLines={2}>{order.title}</Text>
          <Ionicons name="chevron-forward" size={17} color={inkFaint} />
        </View>
        <Text style={styles.orderMeta}>{order.sku === 'matte-hardcover' ? 'Matte hardcover' : 'Matte softcover'} · ordered {formatPrintDate(order.createdAt)}</Text>
        <View style={styles.statusRow}>
          <View style={[styles.statusPill, { backgroundColor: tone.backgroundColor }]}>
            <View style={[styles.statusDot, { backgroundColor: tone.color }]} />
            <Text style={[styles.statusText, { color: tone.color }]}>{printFulfillmentLabel(order.fulfillmentStatus)}</Text>
          </View>
          <Text style={styles.total}>{formatPrintMoney(order.total)}</Text>
        </View>
        {order.paymentStatus !== 'paid' && <Text style={styles.paymentNote}>{printPaymentLabel(order.paymentStatus)}</Text>}
      </View>
    </GlassPressable>
  );
}

export default function CookbookPrintOrdersScreen() {
  const router = useRouter();
  const [orders, setOrders] = useState<CookbookPrintOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const result = await getCookbookPrintOrders();
      setOrders([...result].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
    } catch (caught: any) {
      setError(caught?.message || 'Could not load your print orders.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  return (
    <AmbientBackground>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <GlassPressable style={styles.headerButton} onPress={() => router.back()} accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={23} color={ink} />
          </GlassPressable>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>YOUR PRINTED COOKBOOKS</Text>
            <Text style={styles.headerTitle}>Orders</Text>
          </View>
          <GlassPressable style={styles.headerButton} onPress={() => router.push('/print-cookbook' as any)} accessibilityLabel="Open cookbook print builder">
            <Ionicons name="add" size={23} color={ink} />
          </GlassPressable>
        </View>

        {loading && !orders.length ? (
          <View style={styles.centered}><ActivityIndicator size="large" color={primary} /><Text style={styles.loadingText}>Finding your cookbooks…</Text></View>
        ) : (
          <FlatList
            data={orders}
            keyExtractor={(order) => order.id}
            contentContainerStyle={[styles.list, !orders.length && styles.emptyList]}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void load(true); }} tintColor={primary} />}
            ListHeaderComponent={orders.length ? <View style={styles.intro}><Text style={styles.introTitle}>Made to be kept</Text><Text style={styles.introText}>Track production, delivery, and reprints from the live order record.</Text></View> : null}
            renderItem={({ item }) => (
              <OrderCard
                order={item}
                onPress={() => router.push({ pathname: '/print-cookbook/orders/[orderId]', params: { orderId: item.id } } as any)}
              />
            )}
            ListEmptyComponent={(
              <View style={styles.empty}>
                <View style={styles.emptyIcon}><Ionicons name="book-outline" size={36} color={primary} /></View>
                <Text style={styles.emptyTitle}>Nothing at the printer yet</Text>
                <Text style={styles.emptyText}>When you approve a page preview and finish payment, its live status will stay here.</Text>
                <GlassPressable style={styles.primaryButton} onPress={() => router.push('/print-cookbook' as any)}>
                  <Text style={styles.primaryButtonText}>Design a cookbook</Text>
                  <Ionicons name="arrow-forward" size={18} color="#fff" />
                </GlassPressable>
              </View>
            )}
            ListFooterComponent={error && orders.length ? <GlassPressable style={styles.errorCard} onPress={() => { void load(); }}><Ionicons name="cloud-offline-outline" size={19} color="#974B45" /><Text style={styles.errorText}>{error} Tap to try again.</Text></GlassPressable> : <View style={{ height: 24 }} />}
          />
        )}
        {!!error && !orders.length && !loading && <View style={styles.centered}><View style={styles.emptyIcon}><Ionicons name="cloud-offline-outline" size={34} color={primary} /></View><Text style={styles.emptyTitle}>Orders are out of reach</Text><Text style={styles.emptyText}>{error}</Text><GlassPressable style={styles.primaryButton} onPress={() => { void load(); }}><Text style={styles.primaryButtonText}>Try again</Text></GlassPressable></View>}
      </SafeAreaView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16 },
  headerButton: { width: 43, height: 43, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.76)', borderWidth: 1, borderColor: '#fff' },
  headerCopy: { flex: 1 },
  eyebrow: { color: inkMuted, fontSize: 9, letterSpacing: 1.45, fontWeight: '800' },
  headerTitle: { color: ink, fontSize: 29, lineHeight: 34, letterSpacing: -0.8, fontWeight: '700', marginTop: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 13, paddingHorizontal: 34 },
  loadingText: { color: inkMuted, fontSize: 13 },
  list: { paddingHorizontal: 20, paddingBottom: 36 },
  emptyList: { flexGrow: 1 },
  intro: { paddingTop: 6, paddingBottom: 21 },
  introTitle: { color: ink, fontSize: 24, lineHeight: 29, letterSpacing: -0.7, fontWeight: '700' },
  introText: { color: inkMuted, fontSize: 13, lineHeight: 20, marginTop: 5, maxWidth: 330 },
  orderCard: { minHeight: 141, flexDirection: 'row', alignItems: 'center', gap: 14, padding: 13, borderRadius: 27, marginBottom: 12, backgroundColor: 'rgba(255,255,255,0.64)', borderWidth: 1, borderColor: '#fff' },
  bookMark: { width: 75, height: 104, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: mint, borderWidth: 1, borderColor: '#CFE0D2', overflow: 'hidden' },
  bookSpine: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 8, backgroundColor: 'rgba(35,120,94,0.12)', borderRightWidth: 1, borderRightColor: 'rgba(35,120,94,0.13)' },
  orderCopy: { flex: 1 },
  orderTitleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  orderTitle: { flex: 1, color: ink, fontSize: 17, lineHeight: 21, fontWeight: '700', letterSpacing: -0.3 },
  orderMeta: { color: inkMuted, fontSize: 10, lineHeight: 15, marginTop: 5 },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 12 },
  statusPill: { minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 15, paddingHorizontal: 9 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 9, fontWeight: '800' },
  total: { color: ink, fontSize: 13, fontWeight: '800' },
  paymentNote: { color: '#974B45', fontSize: 9, fontWeight: '700', marginTop: 7 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 15, paddingBottom: 60 },
  emptyIcon: { width: 76, height: 76, borderRadius: 27, alignItems: 'center', justifyContent: 'center', backgroundColor: mint },
  emptyTitle: { color: ink, fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.5, textAlign: 'center' },
  emptyText: { color: inkMuted, fontSize: 13, lineHeight: 20, textAlign: 'center', maxWidth: 330 },
  primaryButton: { minHeight: 50, borderRadius: 21, backgroundColor: primary, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 7 },
  primaryButtonText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  errorCard: { flexDirection: 'row', gap: 8, alignItems: 'center', borderRadius: 18, padding: 13, backgroundColor: '#F5E2DF', marginTop: 7 },
  errorText: { flex: 1, color: '#85433D', fontSize: 11, lineHeight: 16 },
});
