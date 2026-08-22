// components/CookMode.tsx
//
// WHY THIS EXISTS
//
// The recipe screen next door is a document: a photo, a description, an author,
// a scrolling list of steps. That is the right shape for deciding what to cook
// and the wrong shape for cooking it. In a kitchen the phone is on a worktop,
// the user's hands are wet or covered in flour, the screen locks after thirty
// seconds, and the one question they have is "which step was I on".
//
// So this is the same recipe with everything that is not that removed: the
// screen stays awake, a tap marks a step done, the amounts are the ones the
// shopping was actually done at, and the durations the steps mention are
// timers you can start rather than numbers you have to go and re-enter in the
// clock app.
//
// WHY THE TIMERS ARE WALL-CLOCK
//
// Every timer stores the moment it ENDS, not how much is left. An interval that
// decrements a counter loses time whenever the OS throttles it in the
// background, so a 20-minute timer set before answering the door comes back
// reading eight minutes with the pasta gone. Ticking is only for redrawing.
//
// A local notification is scheduled alongside each timer, because the whole
// point is that the user can walk away.

import { Ingredient, Recipe } from '@/types/types';
import { findStepTimers, formatCountdown, formatDuration } from '@/utils/cookTimers';
import { displayQuantity, nextUnitInCycle } from '@/utils/quantity';
import { scaleIngredients } from '@/utils/servings';
import { accentSoft, hairline, ink, inkFaint, inkMuted, primary, surface } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import * as Notifications from 'expo-notifications';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

interface CookModeProps {
  recipe: Recipe;
  /** `Meal.scale` — the factor this recipe's shopping was done at. */
  scale?: number;
  onClose: () => void;
}

interface RunningTimer {
  /** Stable across renders: which step, and which duration within it. */
  key: string;
  label: string;
  /** Epoch ms. See the header: wall-clock, not a decrementing counter. */
  endsAt: number;
  notificationId?: string;
}

const timerKey = (stepIndex: number, seconds: number) => `${stepIndex}:${seconds}`;

export default function CookMode({ recipe, scale = 1, onClose }: CookModeProps) {
  // The single most important line in the file. Everything else is a
  // convenience; a screen that locks mid-step makes the whole mode pointless.
  useKeepAwake();

  const [doneSteps, setDoneSteps] = useState<Set<number>>(() => new Set());
  const [showIngredients, setShowIngredients] = useState(false);
  /**
   * Per-row unit the cook has tapped to. Same gesture as the recipe screen next
   * door, and it matters more here: this is the list being read with a scale in
   * one hand, and "8 oz" is not a number a metric scale can help with.
   */
  const [unitChoices, setUnitChoices] = useState<Record<number, string>>({});
  const [timers, setTimers] = useState<RunningTimer[]>([]);
  const [finished, setFinished] = useState<Set<string>>(() => new Set());

  // Redraw clock. Only ever used to recompute what is ALREADY true from
  // `endsAt`, so a throttled or skipped tick costs a stale display for a moment
  // and never costs time off a timer.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (timers.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [timers.length]);

  const ingredients: Ingredient[] = useMemo(
    () => scaleIngredients(recipe.ingredients ?? [], scale) as Ingredient[],
    [recipe.ingredients, scale],
  );

  // Memoised so the identity is stable: `steps` feeds the timer scan and
  // `startTimer`, and a fresh `[]` on every render would re-scan every step's
  // prose on every tick of the countdown clock.
  const steps = useMemo(() => recipe.instructions ?? [], [recipe.instructions]);
  const stepTimers = useMemo(() => steps.map((step) => findStepTimers(step)), [steps]);

  // Fires the alert exactly once per timer, from the render that first sees it
  // expired. Kept in a ref as well as state so a double tick can't double-buzz.
  const firedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const timer of timers) {
      if (timer.endsAt > now || firedRef.current.has(timer.key)) continue;
      firedRef.current.add(timer.key);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setFinished((prev) => new Set(prev).add(timer.key));
    }
  }, [now, timers]);

  /** Tap an amount to read it in another unit — see `conversionCycle`. */
  const cycleUnit = useCallback((index: number, cycle: string[], current: string | null) => {
    const next = nextUnitInCycle(cycle, current);
    if (!next) return;
    Haptics.selectionAsync().catch(() => {});
    setUnitChoices((prev) => ({ ...prev, [index]: next }));
  }, []);

  const startTimer = useCallback(async (stepIndex: number, seconds: number, label: string) => {
    const key = timerKey(stepIndex, seconds);
    const endsAt = Date.now() + seconds * 1000;

    firedRef.current.delete(key);
    setFinished((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setTimers((prev) => [...prev.filter((t) => t.key !== key), { key, label, endsAt }]);
    setNow(Date.now());
    Haptics.selectionAsync().catch(() => {});

    // Best-effort. A timer that only works while the app is open is still a
    // working timer; one that fails to schedule must not take the countdown
    // down with it.
    try {
      const notificationId = await Notifications.scheduleNotificationAsync({
        content: {
          title: `${label} up`,
          body: steps[stepIndex] ? `Step ${stepIndex + 1}: ${steps[stepIndex]}` : recipe.name,
          data: { type: 'cook-timer' },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds,
          repeats: false,
        },
      });
      setTimers((prev) => prev.map((t) => (t.key === key ? { ...t, notificationId } : t)));
    } catch (error) {
      console.error('Could not schedule a cook timer notification:', error);
    }
  }, [recipe.name, steps]);

  const stopTimer = useCallback((key: string) => {
    setTimers((prev) => {
      const timer = prev.find((t) => t.key === key);
      if (timer?.notificationId) {
        Notifications.cancelScheduledNotificationAsync(timer.notificationId).catch(() => {});
      }
      return prev.filter((t) => t.key !== key);
    });
    firedRef.current.delete(key);
    setFinished((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  // Leaving cook mode takes its timers with it. A notification for a pan that
  // is no longer on the hob is worse than no notification.
  //
  // Read through a ref with EMPTY deps, which is load-bearing rather than a
  // lint dodge: depending on `timers` would run this cleanup every time the
  // list changed, so starting a second timer would cancel the first one's
  // notification. Empty deps make it fire once, on unmount, against whatever
  // the live list is by then.
  const timersRef = useRef<RunningTimer[]>([]);
  timersRef.current = timers;
  useEffect(() => () => {
    for (const timer of timersRef.current) {
      if (timer.notificationId) {
        Notifications.cancelScheduledNotificationAsync(timer.notificationId).catch(() => {});
      }
    }
  }, []);

  const toggleStep = (index: number) => {
    Haptics.selectionAsync().catch(() => {});
    setDoneSteps((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const doneCount = doneSteps.size;
  const progress = steps.length > 0 ? doneCount / steps.length : 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onClose} style={styles.headerButton} accessibilityRole="button" accessibilityLabel="Leave cook mode" hitSlop={8}>
          <Ionicons name="chevron-down" size={26} color={inkMuted} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle} numberOfLines={1}>{recipe.name}</Text>
          <Text style={styles.headerProgress}>
            {doneCount} of {steps.length} done
          </Text>
        </View>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {/* Closed by default. Mid-cook the steps are the thing; the amounts are
            a question you occasionally go back to, not the screen you want to
            scroll past every time. */}
        <Pressable
          style={styles.ingredientsHeader}
          onPress={() => setShowIngredients((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: showIngredients }}
        >
          <Ionicons name={showIngredients ? 'chevron-down' : 'chevron-forward'} size={14} color={inkMuted} />
          <Text style={styles.ingredientsHeaderText}>Ingredients</Text>
          <Text style={styles.ingredientsCount}>{ingredients.length}</Text>
          {scale !== 1 && <Text style={styles.scaledFlag}>scaled</Text>}
        </Pressable>
        {showIngredients && (
          <View style={styles.ingredientsCard}>
            {ingredients.map((ing, index) => {
              const view = displayQuantity(ing.quantity, unitChoices[index]);
              return (
                <Pressable
                  key={`ing-${index}`}
                  style={({ pressed }) => [
                    styles.ingredientRow,
                    index > 0 && styles.ingredientDivider,
                    pressed && view.convertible && styles.ingredientRowPressed,
                  ]}
                  onPress={view.convertible ? () => cycleUnit(index, view.cycle, view.unit) : undefined}
                  disabled={!view.convertible}
                  accessibilityRole={view.convertible ? 'button' : undefined}
                  accessibilityLabel={view.convertible ? `${view.text} ${ing.name}. Tap to change units.` : undefined}
                >
                  <Text style={styles.ingredientText}>
                    {!!view.text && <Text style={styles.ingredientQuantity}>{view.text} </Text>}
                    {ing.name}
                  </Text>
                  {view.convertible && (
                    <Ionicons name="swap-horizontal" size={14} color={view.converted ? primary : inkFaint} style={styles.ingredientSwap} />
                  )}
                </Pressable>
              );
            })}
          </View>
        )}

        {steps.map((step, index) => {
          const isDone = doneSteps.has(index);
          return (
            <Pressable
              key={`step-${index}`}
              style={[styles.step, isDone && styles.stepDone]}
              onPress={() => toggleStep(index)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isDone }}
              accessibilityLabel={`Step ${index + 1}. ${step}`}
            >
              <View style={styles.stepHeader}>
                <View style={[styles.stepBadge, isDone && styles.stepBadgeDone]}>
                  {isDone
                    ? <Ionicons name="checkmark" size={16} color="#fff" />
                    : <Text style={styles.stepNumber}>{index + 1}</Text>}
                </View>
                <Text style={[styles.stepText, isDone && styles.stepTextDone]}>{step}</Text>
              </View>

              {stepTimers[index]!.length > 0 && (
                <View style={styles.timerRow}>
                  {stepTimers[index]!.map((t) => {
                    const key = timerKey(index, t.seconds);
                    const running = timers.find((r) => r.key === key);
                    const isFinished = finished.has(key);
                    const remaining = running ? (running.endsAt - now) / 1000 : 0;

                    return (
                      <Pressable
                        key={key}
                        style={[
                          styles.timerChip,
                          running && styles.timerChipRunning,
                          isFinished && styles.timerChipFinished,
                        ]}
                        onPress={() => (running ? stopTimer(key) : startTimer(index, t.seconds, t.label))}
                        accessibilityRole="button"
                        accessibilityLabel={
                          running
                            ? `Stop the ${t.label} timer`
                            : `Start a ${t.label} timer for step ${index + 1}`
                        }
                      >
                        <Ionicons
                          name={isFinished ? 'alarm' : running ? 'stop-circle-outline' : 'timer-outline'}
                          size={15}
                          color={running || isFinished ? '#fff' : primary}
                        />
                        <Text style={[styles.timerChipText, (running || isFinished) && styles.timerChipTextActive]}>
                          {isFinished ? 'Time' : running ? formatCountdown(remaining) : formatDuration(t.seconds)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </Pressable>
          );
        })}

        <View style={styles.footerSpacer} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, gap: 6 },
  headerButton: { padding: 4 },
  headerText: { flex: 1 },
  headerTitle: { fontSize: 17, fontWeight: '700', color: ink },
  headerProgress: { fontSize: 13, color: inkMuted, marginTop: 1 },
  progressTrack: { height: 3, backgroundColor: hairline },
  progressFill: { height: 3, backgroundColor: primary },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 14 },

  ingredientsHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10 },
  ingredientsHeaderText: { fontSize: 13, fontWeight: '700', color: inkMuted, letterSpacing: 1.1, textTransform: 'uppercase' },
  ingredientsCount: { fontSize: 13, color: inkFaint },
  scaledFlag: { fontSize: 11, color: primary, backgroundColor: accentSoft, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, overflow: 'hidden' },
  ingredientsCard: { backgroundColor: surface, borderRadius: 12, paddingHorizontal: 14, marginBottom: 8 },
  ingredientRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 10 },
  ingredientRowPressed: { opacity: 0.6 },
  // Nudged down to sit on the text's optical centre, not its ascender.
  ingredientSwap: { marginTop: 3 },
  ingredientDivider: { borderTopWidth: 1, borderTopColor: hairline },
  ingredientText: { flex: 1, fontSize: 15, color: ink },
  ingredientQuantity: { fontWeight: '700', color: primary },

  // Generous vertical padding on purpose: this is a tap target for someone
  // whose hands are busy, aimed at from a worktop rather than up close.
  step: { paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: hairline },
  stepDone: { opacity: 0.45 },
  stepHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  stepBadge: { width: 30, height: 30, borderRadius: 15, backgroundColor: accentSoft, alignItems: 'center', justifyContent: 'center' },
  stepBadgeDone: { backgroundColor: primary },
  stepNumber: { fontSize: 14, fontWeight: '700', color: primary },
  stepText: { flex: 1, fontSize: 17, lineHeight: 26, color: ink, marginTop: 2 },
  stepTextDone: { textDecorationLine: 'line-through', color: inkMuted },

  timerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12, marginLeft: 44 },
  timerChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 16, backgroundColor: accentSoft },
  timerChipRunning: { backgroundColor: primary },
  timerChipFinished: { backgroundColor: '#c9772f' },
  timerChipText: { fontSize: 13, fontWeight: '700', color: primary, fontVariant: ['tabular-nums'] },
  timerChipTextActive: { color: '#fff' },

  footerSpacer: { height: 60 },
});
