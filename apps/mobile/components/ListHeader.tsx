import { useLists } from '@/context/ListContext';
import { List, ListView } from '@/types/types';
import { canvas, ink, inkMuted, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useMemo, useState } from 'react';
import { Dimensions, FlatList, Platform, StatusBar, StyleSheet, Text, View } from 'react-native';
import Modal from 'react-native-modal';
import Animated, { ReduceMotion, useAnimatedStyle, useDerivedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getWeekLabel, parseWeekEnd, parseWeekStart } from '../utils/date';
import GroupIndicator from './GroupIndicator';
import { GlassPressable, GlassSurface, useGlassPreferences } from './ui/Glass';

const DEVICE_HEIGHT = Dimensions.get('window').height + (Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0);
const dateRange = (week: List) => `${parseWeekStart(week.weekStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${parseWeekEnd(week.weekStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

export default function ListHeader() {
  const { allLists, selectedList, selectList, selectedView, selectView } = useLists();
  const insets = useSafeAreaInsets();
  const { reduceMotion } = useGlassPreferences();
  const [isModalVisible, setModalVisible] = useState(false);
  const [width, setWidth] = useState(0);
  const weeksNewestFirst = useMemo(() => [...allLists].sort((a, b) => parseWeekStart(b.weekStart).getTime() - parseWeekStart(a.weekStart).getTime()), [allLists]);
  const segment = Math.max(0, (width - 10) / 2);
  const progress = useDerivedValue(() => {
    const target = selectedView === ListView.GroceryList ? 0 : 1;
    return reduceMotion ? target : withSpring(target, { damping: 21, stiffness: 250, mass: 0.7, reduceMotion: ReduceMotion.System });
  }, [selectedView, reduceMotion]);
  const selectionStyle = useAnimatedStyle(() => ({ transform: [{ translateX: progress.value * segment }] }));
  const handleSelectList = (list: List) => { setModalVisible(false); selectList(list); };
  if (!selectedList) return <View style={{ backgroundColor: canvas, height: insets.top }} />;

  return (
    <>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View pointerEvents="none" style={styles.glow} />
        <View style={styles.brandRow}>
          <View style={styles.wordmark}><View style={styles.brandIcon}><Ionicons name="leaf" size={16} color={primary} /></View><Text style={styles.brand}>fridgie<Text style={{ color: primary }}>.</Text></Text></View>
          <GroupIndicator />
        </View>
        <View style={styles.titleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>GOOD FOOD STARTS HERE</Text>
            <Text style={styles.title}>{getWeekLabel(selectedList.weekStart)}</Text>
          </View>
          <GlassPressable accessibilityLabel={`Choose week. ${dateRange(selectedList)}`} onPress={() => setModalVisible(true)}>
            <GlassSurface style={styles.calendarButton} intensity={35}><Ionicons name="calendar-outline" size={20} color={primary} /><Ionicons name="chevron-down" size={12} color={inkMuted} /></GlassSurface>
          </GlassPressable>
        </View>
        <GlassPressable style={styles.dateButton} onPress={() => setModalVisible(true)} accessibilityLabel="Choose a different week">
          <Text style={styles.subtitle}>{dateRange(selectedList)}</Text><View style={styles.dateDot} /><Text style={styles.dateHint}>Let’s make it delicious</Text>
        </GlassPressable>
        <GlassSurface intensity={45} style={styles.selector} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
          {width > 0 && <Animated.View pointerEvents="none" style={[styles.selection, { width: segment }, selectionStyle]} />}
          {[{ value: ListView.GroceryList, label: 'Groceries', icon: 'basket-outline' }, { value: ListView.MealPlan, label: 'Meal plan', icon: 'restaurant-outline' }].map(item => {
            const selected = selectedView === item.value;
            return <GlassPressable key={item.value} style={styles.segment} accessibilityLabel={item.label} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => selectView(item.value)}>
              <Ionicons name={item.icon as 'basket-outline' | 'restaurant-outline'} size={18} color={selected ? ink : inkMuted} />
              <Text style={[styles.segmentText, selected && styles.segmentSelected]}>{item.label}</Text>
            </GlassPressable>;
          })}
        </GlassSurface>
      </View>
      <Modal isVisible={isModalVisible} onBackdropPress={() => setModalVisible(false)} onBackButtonPress={() => setModalVisible(false)} swipeDirection="down" propagateSwipe onSwipeComplete={() => setModalVisible(false)} backdropOpacity={0.25} style={styles.modal} statusBarTranslucent coverScreen deviceHeight={DEVICE_HEIGHT} useNativeDriverForBackdrop animationInTiming={reduceMotion ? 0 : 350} animationOutTiming={reduceMotion ? 0 : 250}>
        <GlassSurface intensity={90} style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]} accessibilityViewIsModal>
          <View style={styles.grabber} />
          <View style={styles.sheetHeading}><View><Text style={styles.eyebrow}>MAKE ROOM FOR GOOD FOOD</Text><Text style={styles.sheetTitle}>Pick your week</Text></View><GlassPressable onPress={() => setModalVisible(false)} style={styles.close} accessibilityLabel="Close week selector"><Ionicons name="close" size={22} color={ink} /></GlassPressable></View>
          <FlatList data={weeksNewestFirst} keyExtractor={list => list.id} contentContainerStyle={{ paddingBottom: 12 }} renderItem={({ item }) => {
            const selected = item.id === selectedList.id;
            return <GlassPressable onPress={() => handleSelectList(item)} style={[styles.weekItem, selected && styles.selectedWeek]} accessibilityState={{ selected }}>
              <View style={[styles.weekIcon, selected && { backgroundColor: '#D5E9DB' }]}><Ionicons name="calendar-outline" size={23} color={primary} /></View>
              <View style={{ flex: 1 }}><Text style={styles.weekText}>{getWeekLabel(item.weekStart)}</Text><Text style={styles.weekRange}>{dateRange(item)}</Text></View>
              <Ionicons name={selected ? 'checkmark-circle' : 'chevron-forward'} size={selected ? 25 : 18} color={selected ? primary : inkMuted} />
            </GlassPressable>;
          }} />
        </GlassSurface>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  header: { backgroundColor: canvas, paddingHorizontal: 24, paddingBottom: 14, overflow: 'hidden' },
  glow: { position: 'absolute', width: 300, height: 300, right: -140, top: -170, borderRadius: 150, backgroundColor: 'rgba(194,222,201,0.3)' },
  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 19 },
  wordmark: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  brandIcon: { width: 29, height: 29, backgroundColor: '#E0EDDF', borderRadius: 10, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-8deg' }] },
  brand: { fontSize: 24, fontWeight: '800', letterSpacing: -1.2, color: ink },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  eyebrow: { color: inkMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.7, marginBottom: 5 },
  title: { fontSize: 35, lineHeight: 41, fontWeight: '700', letterSpacing: -1.5, color: ink },
  calendarButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, width: 68, height: 48, borderRadius: 24 },
  dateButton: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7, minHeight: 30, marginTop: 2, marginBottom: 15 },
  subtitle: { fontSize: 12, fontWeight: '600', color: inkMuted },
  dateDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: '#B4BFB5' },
  dateHint: { fontSize: 12, color: inkMuted },
  selector: { flexDirection: 'row', height: 52, borderRadius: 27, padding: 5, backgroundColor: 'rgba(230,236,227,0.7)', boxShadow: '0 2px 8px rgba(23,63,53,0.025)' },
  selection: { position: 'absolute', left: 4, top: 4, bottom: 4, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 23, borderWidth: 1, borderColor: 'white', boxShadow: '0 2px 6px rgba(23,63,53,0.1)' },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7, borderRadius: 24 },
  segmentText: { fontSize: 14, fontWeight: '500', color: inkMuted },
  segmentSelected: { color: ink, fontWeight: '700' },
  modal: { margin: 0, justifyContent: 'flex-end' },
  sheet: { borderRadius: 34, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, padding: 22, maxHeight: '75%', backgroundColor: 'rgba(245,248,239,0.94)' },
  grabber: { width: 36, height: 5, borderRadius: 3, backgroundColor: '#C3CEC2', alignSelf: 'center', marginTop: -9, marginBottom: 25 },
  sheetHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 },
  sheetTitle: { fontSize: 29, color: ink, fontWeight: '700', letterSpacing: -1 },
  close: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.75)' },
  weekItem: { flexDirection: 'row', alignItems: 'center', gap: 13, padding: 14, borderRadius: 23, marginBottom: 8, minHeight: 78 },
  selectedWeek: { backgroundColor: 'rgba(222,237,222,0.8)', borderWidth: 1, borderColor: 'white' },
  weekIcon: { width: 46, height: 46, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.6)', alignItems: 'center', justifyContent: 'center' },
  weekText: { fontSize: 16, fontWeight: '600', color: ink },
  weekRange: { fontSize: 13, marginTop: 5, color: inkMuted },
});
