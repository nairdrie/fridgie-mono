// components/MealPlanView.tsx
import { useKeyboardAwareScroll } from "@/hooks/useKeyboardAwareScroll";
import { Item, Meal } from "@/types/types";
import { formatQuantity, parseQuantity } from "@/utils/quantity";
import { accentSoft, ink, inkMuted, primary } from "@/utils/styles";
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useMemo, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
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
  onToggleCookbook
}: MealPlanViewProps) {

  const [isModalVisible, setIsModalVisible] = useState(false);
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);

  // Every input in the plan — a meal's name, an ingredient's text — is inside
  // this list, and focus bubbles, so the list hears all of them.
  const keyboard = useKeyboardAwareScroll();

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

  const plannedDays = new Set(meals.map(meal => meal.dayOfWeek).filter(Boolean));
  const ingredientCount = items.filter(item => !item.isSection && item.mealId && item.text?.trim()).length;

  const overview = (
    <View style={styles.overview}>
      <View style={styles.overviewHeading}>
        <View style={{ flex: 1 }}>
          <Text style={styles.eyebrow}>A LITTLE PLANNING, A LOT TO LOVE</Text>
          <Text style={styles.overviewTitle}>Your delicious week.</Text>
        </View>
        <View style={styles.overviewIcon}><Ionicons name="restaurant-outline" size={22} color={primary} /></View>
      </View>
      <GlassSurface style={styles.weekCard} intensity={28}>
        <View style={styles.weekSummary}>
          <Text style={styles.weekSummaryTitle}>{meals.length} meal{meals.length === 1 ? '' : 's'} on the menu</Text>
          <Text style={styles.weekSummaryDetail}>{ingredientCount} ingredient{ingredientCount === 1 ? '' : 's'}</Text>
        </View>
        <View style={styles.weekDays}>
          {DAYS_OF_WEEK.map((day, index) => {
            const planned = plannedDays.has(day);
            return (
              <View key={day} style={styles.weekDay} accessibilityLabel={`${day}, ${planned ? 'meal planned' : 'open'}`}>
                <Text style={[styles.weekDayLabel, planned && styles.weekDayLabelPlanned]}>{['S', 'M', 'T', 'W', 'T', 'F', 'S'][index]}</Text>
                <View style={[styles.weekDayDot, planned && styles.weekDayDotPlanned]}>
                  {planned && <Ionicons name="checkmark" size={13} color="#fff" />}
                </View>
              </View>
            );
          })}
        </View>
      </GlassSurface>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>On the menu</Text>
        <Text style={styles.sectionDetail}>{plannedDays.size} day{plannedDays.size === 1 ? '' : 's'} planned</Text>
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
     {sortedMeals.length === 0 && (
      <ScrollView contentContainerStyle={styles.emptyMealsContainer} showsVerticalScrollIndicator={false}>
        <View style={styles.emptyIllustration}>
          <View style={styles.emptyOrbit} />
          <View style={[styles.emptyAccent, styles.emptyAccentLeft]}><Ionicons name="leaf" size={22} color={primary} /></View>
          <GlassSurface style={styles.emptyIcon} intensity={45}>
            <Ionicons name="restaurant-outline" size={43} color={primary} />
          </GlassSurface>
          <View style={[styles.emptyAccent, styles.emptyAccentRight]}><Ionicons name="sparkles" size={21} color="#B66D4E" /></View>
        </View>
        <Text style={styles.eyebrow}>GOOD FOOD STARTS HERE</Text>
        <Text style={styles.emptyMealsText}>Make room for{`\n`}something delicious.</Text>
        <Text style={styles.emptySubtext}>Plan a few meals. We’ll bring all the ingredients together on your shopping list.</Text>
        <View style={styles.emptyActions}>
          <GlassPressable style={[styles.emptyAction, styles.emptyActionPrimary]} onPress={onAddMeal} accessibilityRole="button">
            <Ionicons name="add" size={22} color="#fff" />
            <Text style={[styles.emptyActionText, styles.emptyActionTextPrimary]}>Plan your first meal</Text>
          </GlassPressable>
          <View style={styles.emptySecondaryActions}>
            <GlassPressable style={styles.emptySecondaryAction} onPress={onAddFromCookbook} accessibilityRole="button">
              <Ionicons name="book-outline" size={21} color={primary} />
              <Text style={styles.emptySecondaryText}>Cookbook</Text>
            </GlassPressable>
            <GlassPressable style={styles.emptySecondaryAction} onPress={onSuggestMeal} accessibilityRole="button">
              <Ionicons name="sparkles-outline" size={21} color={primary} />
              <Text style={styles.emptySecondaryText}>Inspire me</Text>
            </GlassPressable>
          </View>
        </View>
      </ScrollView>
     )}
     { sortedMeals.length > 0 && 
      <FlatList
        ref={keyboard.scrollRef}
        {...keyboard.scrollProps}
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
  overview: { paddingTop: 12 },
  overviewHeading: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 19 },
  eyebrow: { color: inkMuted, fontSize: 10, letterSpacing: 1.6, fontWeight: '700' },
  overviewTitle: { fontSize: 29, lineHeight: 35, letterSpacing: -1.2, color: ink, fontWeight: '700', marginTop: 7 },
  overviewIcon: { width: 45, height: 45, borderRadius: 23, backgroundColor: accentSoft, alignItems: 'center', justifyContent: 'center' },
  weekCard: { padding: 18, borderRadius: 26 },
  weekSummary: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  weekSummaryTitle: { fontSize: 14, fontWeight: '600', color: ink },
  weekSummaryDetail: { fontSize: 12, color: inkMuted },
  weekDays: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 18 },
  weekDay: { alignItems: 'center', flex: 1, gap: 8 },
  weekDayLabel: { color: inkMuted, fontSize: 12, fontWeight: '500' },
  weekDayLabelPlanned: { color: primary, fontWeight: '700' },
  weekDayDot: { width: 23, height: 23, borderRadius: 12, backgroundColor: 'rgba(23,63,53,0.05)', borderWidth: 1, borderColor: 'rgba(23,63,53,0.08)', alignItems: 'center', justifyContent: 'center' },
  weekDayDotPlanned: { backgroundColor: primary, borderColor: primary },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 26, marginBottom: 14 },
  sectionTitle: { fontSize: 21, fontWeight: '700', letterSpacing: -0.6, color: ink },
  sectionDetail: { fontSize: 12, color: inkMuted },
  emptyMealsContainer: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30, paddingTop: 16, paddingBottom: 170 },
  emptyIllustration: { width: 170, height: 110, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  emptyOrbit: { position: 'absolute', width: 108, height: 108, borderRadius: 54, backgroundColor: '#DCEDE2' },
  emptyIcon: { width: 84, height: 84, borderRadius: 28, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-8deg' }] },
  emptyAccent: { position: 'absolute', width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#F5F5EF' },
  emptyAccentLeft: { left: 8, top: 12, backgroundColor: '#E7EEDC', transform: [{ rotate: '-20deg' }] },
  emptyAccentRight: { right: 3, bottom: 13, backgroundColor: '#F4DDD0', transform: [{ rotate: '12deg' }] },
  emptyMealsText: { fontSize: 31, lineHeight: 36, fontWeight: '700', letterSpacing: -1.2, color: ink, textAlign: 'center', marginTop: 11 },
  emptySubtext: { fontSize: 15, lineHeight: 23, color: inkMuted, textAlign: 'center', marginTop: 13, maxWidth: 310 },
  emptyActions: { marginTop: 20, gap: 11, alignSelf: 'stretch', maxWidth: 350, width: '100%', alignItems: 'stretch' },
  emptyAction: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, borderRadius: 28, minHeight: 54, paddingHorizontal: 18 },
  emptyActionPrimary: { backgroundColor: primary, borderWidth: 1, borderColor: 'rgba(255,255,255,0.45)' },
  emptyActionText: { fontSize: 16, fontWeight: '600', color: primary },
  emptyActionTextPrimary: { color: '#fff' },
  emptySecondaryActions: { flexDirection: 'row', gap: 11 },
  emptySecondaryAction: { flex: 1, flexDirection: 'row', gap: 8, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.78)', minHeight: 51, borderRadius: 26, borderWidth: 1, borderColor: 'rgba(255,255,255,0.9)' },
  emptySecondaryText: { color: primary, fontSize: 14, fontWeight: '600' },
});
