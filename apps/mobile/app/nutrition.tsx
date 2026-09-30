import { AmbientBackground, GlassPressable, GlassSurface } from '@/components/ui/Glass';
import { useLists } from '@/context/ListContext';
import { usePro } from '@/context/ProContext';
import {
  ApiError,
  getWeeklyNutrition,
  saveNutritionGoals,
  setMealConsumed,
} from '@/utils/api';
import { getWeekLabel } from '@/utils/date';
import { hairline, ink, inkMuted, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  aggregateWeeklyNutrition,
  NUTRITION_METRICS,
  nutritionGoalProgress,
  validateNutritionGoals,
  weeklyNutritionGoals,
  type NutritionGoals,
  type NutritionMetric,
  type WeeklyNutritionAnalysis,
  type WeeklyNutritionMeal,
} from '@fridgie/shared/nutrition';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const GOAL_FIELDS: { key: NutritionMetric; label: string; shortLabel: string; unit: string; required: boolean }[] = [
  { key: 'calories', label: 'Daily calorie goal', shortLabel: 'Calories', unit: 'cal', required: true },
  { key: 'proteinGrams', label: 'Daily protein goal', shortLabel: 'Protein', unit: 'g', required: true },
  { key: 'carbsGrams', label: 'Daily carbohydrate goal', shortLabel: 'Carbs', unit: 'g', required: false },
  { key: 'fatGrams', label: 'Daily fat goal', shortLabel: 'Fat', unit: 'g', required: false },
  { key: 'fiberGrams', label: 'Daily fiber goal', shortLabel: 'Fiber', unit: 'g', required: false },
];

const DAY_ORDER = new Map([
  ['Sunday', 0], ['Monday', 1], ['Tuesday', 2], ['Wednesday', 3],
  ['Thursday', 4], ['Friday', 5], ['Saturday', 6],
]);

function friendlyError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    // API errors can contain a JSON response body. The product copy is more
    // useful than surfacing that wire format to the user.
    try {
      const parsed = JSON.parse(error.message);
      if (typeof parsed?.message === 'string') return parsed.message;
    } catch {}
    return error.message;
  }
  return fallback;
}

const formatValue = (value: number, metric: NutritionMetric): string =>
  metric === 'calories' ? `${Math.round(value).toLocaleString()} cal` : `${Math.round(value)} g`;

function MetricProgress({
  metric,
  value,
  goals,
}: {
  metric: NutritionMetric;
  value: number;
  goals: NutritionGoals | null;
}) {
  const field = GOAL_FIELDS.find((item) => item.key === metric)!;
  const target = goals ? weeklyNutritionGoals(goals)[metric] : undefined;
  const progress = goals ? nutritionGoalProgress({
    calories: metric === 'calories' ? value : 0,
    proteinGrams: metric === 'proteinGrams' ? value : 0,
    carbsGrams: metric === 'carbsGrams' ? value : 0,
    fatGrams: metric === 'fatGrams' ? value : 0,
    fiberGrams: metric === 'fiberGrams' ? value : 0,
  }, goals)[metric] : undefined;
  const percent = typeof progress === 'number' ? Math.round(progress * 100) : null;
  const barWidth = `${Math.min(100, Math.max(0, percent ?? 0))}%` as `${number}%`;

  return (
    <View style={styles.metric}>
      <View style={styles.metricLabels}>
        <Text style={styles.metricName}>{field.shortLabel}</Text>
        <Text style={styles.metricValue}>
          {formatValue(value, metric)}
          {typeof target === 'number' ? ` of ${formatValue(target, metric)}` : ''}
        </Text>
      </View>
      {typeof target === 'number' && (
        <View
          style={styles.progressTrack}
          accessibilityRole="progressbar"
          accessibilityLabel={`${field.shortLabel} progress`}
          accessibilityValue={{ min: 0, max: 100, now: Math.min(100, percent ?? 0), text: `${percent}% of weekly goal` }}
        >
          <View style={[styles.progressFill, { width: barWidth }]} />
        </View>
      )}
    </View>
  );
}

function SummaryCard({
  title,
  eyebrow,
  analysis,
  kind,
}: {
  title: string;
  eyebrow: string;
  analysis: WeeklyNutritionAnalysis;
  kind: 'planned' | 'consumed';
}) {
  const summary = analysis[kind];
  const shownMetrics = NUTRITION_METRICS.filter((metric) =>
    metric === 'calories'
    || metric === 'proteinGrams'
    || typeof analysis.goals?.[metric] === 'number');
  return (
    <GlassSurface style={styles.summaryCard}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.coverage}>
        {summary.analyzedMeals} of {summary.totalMeals} {summary.totalMeals === 1 ? 'meal' : 'meals'} estimated
      </Text>
      {summary.totalMeals === 0 ? (
        <Text style={[styles.body, styles.summaryMessage]}>
          {kind === 'consumed' ? 'No meals have been marked cooked yet.' : 'There are no meals in this plan yet.'}
        </Text>
      ) : summary.analyzedMeals === 0 ? (
        <Text style={[styles.body, styles.summaryMessage]}>No nutritional totals are available for these meals yet.</Text>
      ) : (
        <View style={styles.metricList}>
          {shownMetrics.map((metric) => (
            <MetricProgress key={metric} metric={metric} value={summary.totals[metric]} goals={analysis.goals} />
          ))}
        </View>
      )}
    </GlassSurface>
  );
}

function MealRow({
  meal,
  updating,
  onToggle,
}: {
  meal: WeeklyNutritionMeal;
  updating: boolean;
  onToggle: () => void;
}) {
  const values = meal.nutrition?.values;
  const estimateText = values
    ? `About ${Math.round(values.calories)} cal · ${Math.round(values.proteinGrams)} g protein per serving`
    : meal.unavailableReason === 'analysis-pending'
      ? 'Estimate queued — refresh in a moment'
      : 'Nutrition estimate unavailable';
  return (
    <View style={styles.mealRow}>
      <View style={styles.mealCopy}>
        <Text style={styles.mealDay}>{meal.dayOfWeek ?? 'Unscheduled'}</Text>
        <Text style={styles.mealName}>{meal.name}</Text>
        <Text style={styles.mealEstimate}>{estimateText}</Text>
      </View>
      <GlassPressable
        style={[styles.cookedButton, meal.consumed && styles.cookedButtonActive]}
        onPress={onToggle}
        disabled={updating}
        accessibilityLabel={meal.consumed ? `Mark ${meal.name} as not cooked` : `Mark ${meal.name} as cooked`}
        accessibilityState={{ selected: meal.consumed, disabled: updating }}
      >
        {updating
          ? <ActivityIndicator size="small" color={meal.consumed ? '#fff' : primary} />
          : <Ionicons name={meal.consumed ? 'checkmark' : 'restaurant-outline'} size={16} color={meal.consumed ? '#fff' : primary} />}
        <Text style={[styles.cookedText, meal.consumed && styles.cookedTextActive]}>
          {meal.consumed ? 'Cooked' : 'Mark cooked'}
        </Text>
      </GlassPressable>
    </View>
  );
}

export default function NutritionScreen() {
  const router = useRouter();
  const { isPro, isLoading: isProLoading, refresh: refreshPro } = usePro();
  const { selectedGroup, selectedList } = useLists();
  const [analysis, setAnalysis] = useState<WeeklyNutritionAnalysis | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingGoals, setEditingGoals] = useState(false);
  const [goalInputs, setGoalInputs] = useState<Record<NutritionMetric, string>>({
    calories: '', proteinGrams: '', carbsGrams: '', fatGrams: '', fiberGrams: '',
  });
  const [goalError, setGoalError] = useState<string | null>(null);
  const [savingGoals, setSavingGoals] = useState(false);
  const [updatingMeal, setUpdatingMeal] = useState<string | null>(null);

  useEffect(() => {
    if (!isProLoading && !isPro) {
      router.replace({ pathname: '/pro', params: { source: 'nutrition' } });
    }
  }, [isPro, isProLoading, router]);

  const redirectIfProRequired = useCallback(async (requestError: unknown): Promise<boolean> => {
    if (!(requestError instanceof ApiError) || requestError.code !== 'pro_required') return false;
    await refreshPro();
    router.replace({ pathname: '/pro', params: { source: 'nutrition' } });
    return true;
  }, [refreshPro, router]);

  const load = useCallback(async (refresh = false) => {
    if (!isPro || !selectedGroup?.id || !selectedList?.id) {
      setIsLoading(false);
      return;
    }
    if (refresh) setIsRefreshing(true);
    else setIsLoading(true);
    setError(null);
    try {
      const next = await getWeeklyNutrition(selectedGroup.id, selectedList.id);
      setAnalysis(next);
      setGoalInputs({
        calories: next.goals?.calories?.toString() ?? '',
        proteinGrams: next.goals?.proteinGrams?.toString() ?? '',
        carbsGrams: next.goals?.carbsGrams?.toString() ?? '',
        fatGrams: next.goals?.fatGrams?.toString() ?? '',
        fiberGrams: next.goals?.fiberGrams?.toString() ?? '',
      });
    } catch (loadError) {
      if (await redirectIfProRequired(loadError)) return;
      setError(friendlyError(loadError, 'Could not load this week’s nutrition analysis.'));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [isPro, redirectIfProRequired, selectedGroup?.id, selectedList?.id]);

  useFocusEffect(useCallback(() => {
    if (isPro) void load();
  }, [isPro, load]));

  const saveGoals = async () => {
    const candidate: Record<string, number | undefined> = {};
    for (const field of GOAL_FIELDS) {
      const text = goalInputs[field.key].trim();
      candidate[field.key] = text ? Number(text) : undefined;
    }
    const validation = validateNutritionGoals(candidate);
    if (!validation.ok) {
      const label = validation.field
        ? GOAL_FIELDS.find((field) => field.key === validation.field)?.label
        : 'Goals';
      setGoalError(`${label ?? 'Goals'} needs a valid positive number.`);
      return;
    }
    setSavingGoals(true);
    setGoalError(null);
    try {
      const goals = await saveNutritionGoals(validation.goals);
      setAnalysis((current) => current ? { ...current, goals } : current);
      setEditingGoals(false);
    } catch (saveError) {
      if (await redirectIfProRequired(saveError)) return;
      setGoalError(friendlyError(saveError, 'Could not save your goals.'));
    } finally {
      setSavingGoals(false);
    }
  };

  const toggleMeal = async (meal: WeeklyNutritionMeal) => {
    if (!analysis || !selectedGroup?.id || !selectedList?.id) return;
    const consumed = !meal.consumed;
    setUpdatingMeal(meal.mealId);
    try {
      await setMealConsumed(selectedGroup.id, selectedList.id, meal.mealId, consumed);
      setAnalysis((current) => {
        if (!current) return current;
        const meals = current.meals.map((item) => item.mealId === meal.mealId ? { ...item, consumed } : item);
        return { ...current, meals, ...aggregateWeeklyNutrition(meals) };
      });
    } catch (toggleError) {
      if (await redirectIfProRequired(toggleError)) return;
      Alert.alert('Could not update meal', friendlyError(toggleError, 'Please try again.'));
    } finally {
      setUpdatingMeal(null);
    }
  };

  const sortedMeals = useMemo(() => [...(analysis?.meals ?? [])].sort((a, b) =>
    (DAY_ORDER.get(a.dayOfWeek ?? '') ?? 99) - (DAY_ORDER.get(b.dayOfWeek ?? '') ?? 99)), [analysis?.meals]);
  const providerLabel = analysis?.meals.find((meal) => meal.nutrition)?.nutrition?.providerLabel;
  const hasUnavailable = analysis?.meals.some((meal) => !meal.nutrition) ?? false;

  if (isProLoading || (!isPro && !isProLoading)) {
    return <AmbientBackground><View style={styles.center}><ActivityIndicator color={primary} /></View></AmbientBackground>;
  }

  return (
    <AmbientBackground>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView style={styles.safeArea} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}>
            <GlassPressable style={styles.backButton} onPress={() => router.back()} accessibilityLabel="Back">
              <Ionicons name="chevron-back" size={22} color={ink} />
            </GlassPressable>
            <View style={styles.headerCopy}>
              <Text style={styles.headerEyebrow}>FRIDGIE PRO</Text>
              <Text style={styles.title}>Nutrition</Text>
            </View>
          </View>

          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => void load(true)} tintColor={primary} />}
          >
            {!selectedGroup || !selectedList ? (
              <GlassSurface style={styles.emptyCard}>
                <Text style={styles.cardTitle}>Choose a meal-plan week first</Text>
                <Text style={styles.body}>Nutrition analysis follows the week selected on your meal plan.</Text>
              </GlassSurface>
            ) : isLoading ? (
              <View style={styles.loadingBlock}>
                <ActivityIndicator color={primary} />
                <Text style={styles.body}>Estimating your week…</Text>
              </View>
            ) : error ? (
              <GlassSurface style={styles.emptyCard} accessibilityLiveRegion="polite">
                <Text style={styles.cardTitle}>Your analysis didn’t load</Text>
                <Text style={styles.body}>{error}</Text>
                <GlassPressable style={styles.primaryButton} onPress={() => void load()}>
                  <Text style={styles.primaryButtonText}>Try again</Text>
                </GlassPressable>
              </GlassSurface>
            ) : analysis && (
              <>
                <View style={styles.intro}>
                  <Text style={styles.weekLabel}>{getWeekLabel(analysis.weekStart || selectedList.weekStart)}</Text>
                  <Text style={styles.body}>A planning view of meals saved in Fridgie, using one serving per meal.</Text>
                </View>

                <GlassSurface style={styles.goalsCard}>
                  <View style={styles.cardHeadingRow}>
                    <View style={styles.cardHeadingCopy}>
                      <Text style={styles.eyebrow}>DAILY TARGETS</Text>
                      <Text style={styles.cardTitle}>Your goals</Text>
                    </View>
                    {!editingGoals && (
                      <GlassPressable style={styles.smallButton} onPress={() => setEditingGoals(true)}>
                        <Text style={styles.smallButtonText}>{analysis.goals ? 'Edit' : 'Set goals'}</Text>
                      </GlassPressable>
                    )}
                  </View>
                  {editingGoals ? (
                    <View style={styles.goalForm}>
                      {GOAL_FIELDS.map((field) => (
                        <View key={field.key} style={styles.goalInputRow}>
                          <View style={styles.goalLabelWrap}>
                            <Text style={styles.goalLabel}>{field.label}</Text>
                            {!field.required && <Text style={styles.optional}>Optional</Text>}
                          </View>
                          <View style={styles.inputWrap}>
                            <TextInput
                              style={styles.input}
                              value={goalInputs[field.key]}
                              onChangeText={(text) => setGoalInputs((current) => ({ ...current, [field.key]: text }))}
                              keyboardType="decimal-pad"
                              inputMode="decimal"
                              placeholder="—"
                              placeholderTextColor="#9AA79F"
                              accessibilityLabel={field.label}
                            />
                            <Text style={styles.inputUnit}>{field.unit}</Text>
                          </View>
                        </View>
                      ))}
                      {!!goalError && <Text style={styles.errorText} accessibilityLiveRegion="polite">{goalError}</Text>}
                      <View style={styles.formActions}>
                        <GlassPressable style={styles.cancelButton} onPress={() => { setEditingGoals(false); setGoalError(null); }} disabled={savingGoals}>
                          <Text style={styles.cancelText}>Cancel</Text>
                        </GlassPressable>
                        <GlassPressable style={styles.primaryButton} onPress={() => void saveGoals()} disabled={savingGoals}>
                          {savingGoals ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.primaryButtonText}>Save goals</Text>}
                        </GlassPressable>
                      </View>
                    </View>
                  ) : analysis.goals ? (
                    <View style={styles.goalChips}>
                      {GOAL_FIELDS.filter((field) => typeof analysis.goals?.[field.key] === 'number').map((field) => (
                        <View key={field.key} style={styles.goalChip}>
                          <Text style={styles.goalChipValue}>{formatValue(analysis.goals![field.key]!, field.key)}</Text>
                          <Text style={styles.goalChipLabel}>{field.shortLabel.toLowerCase()}</Text>
                        </View>
                      ))}
                    </View>
                  ) : (
                    <Text style={styles.body}>Add calorie and protein goals to compare them with this week’s planned and cooked meals.</Text>
                  )}
                </GlassSurface>

                <SummaryCard title="On the plan" eyebrow="PLANNED" analysis={analysis} kind="planned" />
                <SummaryCard title="Marked cooked" eyebrow="CONSUMED" analysis={analysis} kind="consumed" />

                <GlassSurface style={styles.mealsCard}>
                  <Text style={styles.eyebrow}>MEALS</Text>
                  <Text style={styles.cardTitle}>This week</Text>
                  {sortedMeals.length === 0 ? (
                    <Text style={styles.body}>There are no meals in this week’s plan yet.</Text>
                  ) : sortedMeals.map((meal, index) => (
                    <View key={meal.mealId}>
                      {index > 0 && <View style={styles.divider} />}
                      <MealRow meal={meal} updating={updatingMeal === meal.mealId} onToggle={() => void toggleMeal(meal)} />
                    </View>
                  ))}
                </GlassSurface>

                {hasUnavailable && (
                  <View style={styles.notice}>
                    <Ionicons name="information-circle-outline" size={19} color={inkMuted} />
                    <Text style={styles.noticeText}>
                      {!analysis.provider.configured
                        ? 'Nutrition estimates aren’t available right now. Your goals and cooked-meal status are still saved.'
                        : 'Some meals could not be estimated yet. Totals include only the meals shown as estimated above.'}
                    </Text>
                  </View>
                )}
                <View style={styles.disclosure}>
                  <Text style={styles.disclosureText}>
                    All nutritional values are estimates{providerLabel ? ` powered by ${providerLabel}` : ''}. They cover only meals in this Fridgie plan, not everything you eat, and are not medical advice.
                  </Text>
                </View>
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 8, paddingBottom: 10, gap: 13 },
  backButton: { width: 43, height: 43, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1 },
  headerEyebrow: { color: primary, fontSize: 10, lineHeight: 14, letterSpacing: 1.5, fontWeight: '800' },
  title: { color: ink, fontSize: 29, lineHeight: 34, fontWeight: '800', letterSpacing: -0.7 },
  content: { padding: 18, paddingBottom: 44, gap: 14 },
  intro: { paddingHorizontal: 4, marginBottom: 2 },
  weekLabel: { color: ink, fontSize: 20, lineHeight: 27, fontWeight: '800', marginBottom: 4 },
  body: { color: inkMuted, fontSize: 14, lineHeight: 21 },
  loadingBlock: { minHeight: 280, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyCard: { padding: 22, gap: 10 },
  goalsCard: { padding: 20 },
  summaryCard: { padding: 20 },
  mealsCard: { padding: 20 },
  eyebrow: { color: primary, fontSize: 10, lineHeight: 14, fontWeight: '800', letterSpacing: 1.4, marginBottom: 3 },
  cardTitle: { color: ink, fontSize: 20, lineHeight: 26, fontWeight: '800', letterSpacing: -0.35 },
  coverage: { color: inkMuted, fontSize: 12, lineHeight: 18, marginTop: 3 },
  summaryMessage: { marginTop: 13 },
  cardHeadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  cardHeadingCopy: { flex: 1 },
  smallButton: { paddingHorizontal: 14, height: 37, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(35,120,94,0.08)' },
  smallButtonText: { color: primary, fontSize: 13, fontWeight: '700' },
  goalChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 15 },
  goalChip: { backgroundColor: 'rgba(35,120,94,0.07)', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9 },
  goalChipValue: { color: ink, fontSize: 14, fontWeight: '800' },
  goalChipLabel: { color: inkMuted, fontSize: 10, marginTop: 1 },
  goalForm: { marginTop: 15, gap: 12 },
  goalInputRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 },
  goalLabelWrap: { flex: 1 },
  goalLabel: { color: ink, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  optional: { color: inkMuted, fontSize: 10, lineHeight: 14 },
  inputWrap: { width: 116, height: 42, borderWidth: 1, borderColor: hairline, backgroundColor: '#fff', borderRadius: 12, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10 },
  input: { flex: 1, color: ink, fontSize: 15, fontWeight: '700', paddingVertical: 0, textAlign: 'right' },
  inputUnit: { color: inkMuted, fontSize: 11, marginLeft: 5 },
  errorText: { color: '#A44135', fontSize: 12, lineHeight: 18 },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 9, marginTop: 3 },
  cancelButton: { height: 42, paddingHorizontal: 17, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(23,63,53,0.06)' },
  cancelText: { color: ink, fontWeight: '700', fontSize: 13 },
  primaryButton: { minHeight: 42, paddingHorizontal: 18, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: primary },
  primaryButtonText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  metricList: { marginTop: 14, gap: 12 },
  metric: { gap: 6 },
  metricLabels: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  metricName: { color: ink, fontSize: 13, fontWeight: '700' },
  metricValue: { color: inkMuted, fontSize: 11, textAlign: 'right' },
  progressTrack: { height: 7, borderRadius: 4, backgroundColor: 'rgba(35,120,94,0.10)', overflow: 'hidden' },
  progressFill: { height: 7, borderRadius: 4, backgroundColor: primary },
  mealRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  mealCopy: { flex: 1 },
  mealDay: { color: primary, fontSize: 10, lineHeight: 14, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.8 },
  mealName: { color: ink, fontSize: 15, lineHeight: 20, fontWeight: '700', marginTop: 1 },
  mealEstimate: { color: inkMuted, fontSize: 11, lineHeight: 16, marginTop: 2 },
  cookedButton: { minWidth: 104, minHeight: 39, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(35,120,94,0.20)', backgroundColor: 'rgba(255,255,255,0.60)', flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' },
  cookedButtonActive: { backgroundColor: primary, borderColor: primary },
  cookedText: { color: primary, fontSize: 11, fontWeight: '800' },
  cookedTextActive: { color: '#fff' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: hairline },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingHorizontal: 5, paddingVertical: 4 },
  noticeText: { flex: 1, color: inkMuted, fontSize: 12, lineHeight: 18 },
  disclosure: { paddingHorizontal: 7, paddingTop: 3 },
  disclosureText: { color: inkMuted, fontSize: 11, lineHeight: 17, textAlign: 'center' },
});
