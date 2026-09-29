import { BrandMark } from '@/components/ui/Brand';
// components/MealPlanView.tsx
import { useKeyboardAwareScroll } from "@/hooks/useKeyboardAwareScroll";
import { Item, Meal } from "@/types/types";
import { formatQuantity, parseQuantity } from "@/utils/quantity";
import { ink, inkFaint, inkMuted, primary } from "@/utils/styles";
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, NativeScrollEvent, NativeSyntheticEvent, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import MealCard from "./MealCard";
import { GlassPressable, GlassSurface } from "./ui/Glass";
import QuantityEditorModal from "./QuantityEditorModal";

const DAYS_OF_WEEK: Meal['dayOfWeek'][] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayOrder = new Map(DAYS_OF_WEEK.map((day, i) => [day, i]));

/** The floating action button hovers over the list; the last row has to clear it. */
const FAB_CLEARANCE = 190;

interface MealPlanViewProps {
  meals: Meal[];
  items: Item[];
  setAllItems: (callback: (prevItems: Item[]) => Item[]) => void;
  onUpdateMeal: (mealId: string, updates: Partial<Meal>) => void;
  onDeleteMeal: (mealId: string) => void;
  onAddMeal: () => void;
  onAddFromCookbook: () => void;
  onSuggestMeal: () => void;
  onAddRecipe: (meal: Meal) => void;
  collapsedMeals: Record<string, boolean>;
  onToggleMealCollapse: (mealId: string) => void;
  editingId: string;
  setEditingId: React.Dispatch<React.SetStateAction<string>>;
  inputRefs: React.MutableRefObject<Record<string, TextInput | null>>;
  isKeyboardVisible: boolean;
  markDirty: () => void;
  onViewRecipe: (meal: Meal) => void;
  onToggleCookbook: (meal: Meal) => void;
  onScrollOffsetChange?: (offset: number) => void;
}

export default function MealPlanView({
  meals,
  items,
  setAllItems,
  onUpdateMeal,
  onDeleteMeal,
  onAddMeal,
  onAddFromCookbook,
  onSuggestMeal,
  onViewRecipe,
  onAddRecipe,
  editingId,
  setEditingId,
  inputRefs,
  isKeyboardVisible,
  markDirty,
  collapsedMeals,
  onToggleMealCollapse,
  onToggleCookbook,
  onScrollOffsetChange
}: MealPlanViewProps) {

  const [isModalVisible, setIsModalVisible] = useState(false);
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);

  // Every input in the plan — a meal's name, an ingredient's text — is inside
  // this list, and focus bubbles, so the list hears all of them.
  const keyboard = useKeyboardAwareScroll();
  const trackKeyboardScroll = keyboard.scrollProps.onScroll;
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    trackKeyboardScroll(event);
    onScrollOffsetChange?.(event.nativeEvent.contentOffset.y);
  }, [trackKeyboardScroll, onScrollOffsetChange]);

    const openQuantityEditor = (item: Item) => {
        setSelectedItem(item);
        setIsModalVisible(true);
    };

    const closeQuantityEditor = () => {
        setIsModalVisible(false);
        setSelectedItem(null);
    };

    const handleSaveQuantity = (newQuantity: string) => {
        if (!selectedItem) return;
        if(selectedItem.quantity === newQuantity) {
            closeQuantityEditor();
            return;
        }

        // Normalize parseable input ("1 1/2 cup" -> "1.5 cups") so grocery-list
        // aggregation can convert it; keep freeform strings as typed.
        const trimmed = newQuantity.trim();
        const parsed = parseQuantity(trimmed);
        const quantityToSave = parsed ? formatQuantity(parsed.value, parsed.unit) : (trimmed || undefined);

        setAllItems(prev =>
            prev.map(i =>
                i.id === selectedItem.id
                    ? { ...i, quantity: quantityToSave }
                    : i
            )
        );
        markDirty();
        closeQuantityEditor();
    };

  const sortedMeals = useMemo(() => {
    return [...meals].sort((a, b) => {
      const aHasDay = a.dayOfWeek && dayOrder.has(a.dayOfWeek);
      const bHasDay = b.dayOfWeek && dayOrder.has(b.dayOfWeek);

      if (aHasDay && !bHasDay) return -1; // a comes first
      if (!aHasDay && bHasDay) return 1;  // b comes first
      
      if (aHasDay && bHasDay) {
        // Both have days, sort by day of the week
        return dayOrder.get(a.dayOfWeek!)! - dayOrder.get(b.dayOfWeek!)!;
      }
      
      // Neither have days, sort alphabetically by name
      return a.name.localeCompare(b.name);
    });
  }, [meals]);

  const emptyOptions: {
    title: string;
    hint: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    tint: string;
    iconColor: string;
    onPress: () => void;
  }[] = [
    { title: 'Inspire me', hint: 'Get meal ideas to choose from', icon: 'sparkles', tint: '#F4DDD0', iconColor: '#B66D4E', onPress: onSuggestMeal },
    { title: 'From your cookbook', hint: "Plan a recipe you've saved", icon: 'book', tint: '#DCEDE2', iconColor: primary, onPress: onAddFromCookbook },
    { title: 'Start from scratch', hint: 'Name a meal and add its ingredients', icon: 'create', tint: '#E7EEDC', iconColor: primary, onPress: onAddMeal },
  ];

  const plannedDays = new Set(meals.map(meal => meal.dayOfWeek).filter(Boolean));
  const overview = (
    <View style={styles.overview}>
      <View style={styles.summary}>
        <Text style={styles.summaryTitle}>{meals.length} meal{meals.length === 1 ? '' : 's'}</Text>
        <Text style={styles.summaryDetail}>{plannedDays.size} day{plannedDays.size === 1 ? '' : 's'} planned</Text>
      </View>
      <View style={styles.weekDays}>
        {DAYS_OF_WEEK.map((day, index) => {
          const planned = plannedDays.has(day);
          return (
            <View key={day} style={[styles.weekDay, planned && styles.weekDayPlanned]} accessible accessibilityLabel={`${day}, ${planned ? 'meal planned' : 'open'}`}>
              <Text style={[styles.weekDayLabel, planned && styles.weekDayLabelPlanned]}>{['S', 'M', 'T', 'W', 'T', 'F', 'S'][index]}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
     {sortedMeals.length === 0 && (
      <ScrollView contentContainerStyle={styles.emptyMealsContainer} showsVerticalScrollIndicator={false} onScroll={handleScroll} scrollEventThrottle={16}>
        <View style={styles.emptyIllustration}>
          <View style={styles.emptyOrbit} />
          <View style={[styles.emptyAccent, styles.emptyAccentLeft]}><BrandMark size={22} color={primary} /></View>
          <GlassSurface style={styles.emptyIcon} intensity={45}>
            <Ionicons name="restaurant-outline" size={43} color={primary} />
          </GlassSurface>
          <View style={[styles.emptyAccent, styles.emptyAccentRight]}><Ionicons name="sparkles" size={21} color="#B66D4E" /></View>
        </View>
        <Text style={styles.emptyMealsText}>Your meal plan</Text>
        <Text style={styles.emptySubtext}>Pick a way to start. Ingredients go straight to your list.</Text>
        {/* Three equal choices rather than one big button and two small ones:
            which is most useful depends on the week, and writing a meal out by
            hand is usually the least common of the three. Each says what it
            does so nobody has to tap one to find out. */}
        <View style={styles.emptyActions}>
          {emptyOptions.map(option => (
            <GlassPressable
              key={option.title}
              style={styles.emptyOption}
              onPress={option.onPress}
              accessibilityLabel={option.title}
              accessibilityHint={option.hint}
            >
              <View style={[styles.emptyOptionIcon, { backgroundColor: option.tint }]}>
                <Ionicons name={option.icon} size={20} color={option.iconColor} />
              </View>
              <View style={styles.emptyOptionBody}>
                <Text style={styles.emptyOptionTitle}>{option.title}</Text>
                <Text style={styles.emptyOptionHint} numberOfLines={2}>{option.hint}</Text>
              </View>
              <Ionicons name="chevron-forward" size={17} color={inkFaint} />
            </GlassPressable>
          ))}
        </View>
      </ScrollView>
     )}
     { sortedMeals.length > 0 && 
      <FlatList
        ref={keyboard.scrollRef}
        {...keyboard.scrollProps}
        onScroll={handleScroll}
        data={sortedMeals}
        ListHeaderComponent={overview}
        showsVerticalScrollIndicator={false}
        keyExtractor={(item) => item.id}
        // A ScrollView left on the default 'never' captures the first tap
        // anywhere outside a focused input, spends it on dismissing the
        // keyboard, and never passes it to the child. An ingredient's ✕ only
        // exists while that ingredient's input is focused, so every press on it
        // was being eaten here before it reached the button. 'handled' still
        // dismisses the keyboard for taps no child claims.
        keyboardShouldPersistTaps="handled"
        renderItem={({ item: meal }) => (
          <MealCard
            meal={meal}
            allItems={items}
            setAllItems={setAllItems}
            onUpdateMeal={onUpdateMeal}
            onDeleteMeal={onDeleteMeal}
            editingId={editingId}
            setEditingId={setEditingId}
            inputRefs={inputRefs}
            isKeyboardVisible={isKeyboardVisible}
            markDirty={markDirty}
            onViewRecipe={onViewRecipe}
            onAddRecipe={onAddRecipe}
            isCollapsed={!!collapsedMeals[meal.id]}
            onToggleCollapse={onToggleMealCollapse}
            onToggleCookbook={onToggleCookbook}
            onOpenQuantityEditor={openQuantityEditor}
          />
        )}
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        windowSize={10}
        // The last meal's ingredients used to sit at the very end of the
        // content, which is as far as scrolling goes — so tapping one put the
        // keyboard on top of it and there was nothing below to pull up in its
        // place. The room under the plan is what gives that row somewhere to go:
        // enough to clear the floating add button at rest, and the keyboard on
        // top of that while one is being typed into.
        contentContainerStyle={[styles.container, { paddingBottom: (isKeyboardVisible ? 28 : FAB_CLEARANCE) + keyboard.keyboardSpace }]}
      />
     }
      <QuantityEditorModal
          isVisible={isModalVisible}
          item={selectedItem}
          onSave={handleSaveQuantity}
          onClose={closeQuantityEditor}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 20 },
  overview: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 7, paddingBottom: 13 },
  summary: { flex: 1 },
  summaryTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: ink },
  summaryDetail: { fontSize: 12, lineHeight: 17, color: inkMuted, marginTop: 1 },
  weekDays: { flexDirection: 'row', gap: 3 },
  weekDay: { width: 20, height: 25, borderRadius: 10, backgroundColor: 'rgba(23,63,53,0.04)', alignItems: 'center', justifyContent: 'center' },
  weekDayPlanned: { backgroundColor: primary },
  weekDayLabel: { color: inkMuted, fontSize: 10, fontWeight: '500' },
  weekDayLabelPlanned: { color: '#fff', fontWeight: '600' },
  emptyMealsContainer: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30, paddingTop: 16, paddingBottom: 170 },
  emptyIllustration: { width: 170, height: 110, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  emptyOrbit: { position: 'absolute', width: 108, height: 108, borderRadius: 54, backgroundColor: '#DCEDE2' },
  emptyIcon: { width: 84, height: 84, borderRadius: 28, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-8deg' }] },
  emptyAccent: { position: 'absolute', width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#F5F5EF' },
  emptyAccentLeft: { left: 8, top: 12, backgroundColor: '#E7EEDC' },
  emptyAccentRight: { right: 3, bottom: 13, backgroundColor: '#F4DDD0', transform: [{ rotate: '12deg' }] },
  emptyMealsText: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -1.2, color: ink, textAlign: 'center', marginTop: 11 },
  emptySubtext: { fontSize: 15, lineHeight: 23, color: inkMuted, textAlign: 'center', marginTop: 13, maxWidth: 310 },
  emptyActions: { marginTop: 22, gap: 10, alignSelf: 'stretch', maxWidth: 380, width: '100%' },
  emptyOption: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 12, paddingLeft: 12, paddingRight: 14, minHeight: 66, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.8)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.9)' },
  emptyOptionIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  emptyOptionBody: { flex: 1 },
  emptyOptionTitle: { fontSize: 16, fontWeight: '600', color: ink },
  emptyOptionHint: { fontSize: 13, lineHeight: 18, color: inkMuted, marginTop: 1 },
});
