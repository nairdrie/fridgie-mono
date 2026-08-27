// A recipe step, rendered as prose with its oven temperatures made tappable.
//
// The ingredient list next door already lets you tap "8 oz" to read it in
// grams; a step that says "preheat to 400°F" deserves the same courtesy for the
// cook who thinks in Celsius (or the other way round). The hard part — deciding
// which numbers in a sentence are actually temperatures, and never mis-reading a
// tin size or a quantity as one — lives in packages/shared/cookTemperatures.ts
// and is tested there. This component is just the rendering and the tap.
//
// The temperature is an inline <Text> inside the step's <Text>, so it flows with
// the sentence and wraps with it. Tapping one toggles ONLY that reading between
// scales; everything else on the screen, and every other temperature in the
// step, stays put.

import { accentSoft, primary } from '@/utils/styles';
import {
  convertTemperature,
  formatTemperature,
  splitStepTemperatures,
} from '@/utils/cookTemperatures';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useState } from 'react';
import { GestureResponderEvent, StyleProp, StyleSheet, Text, TextStyle } from 'react-native';

interface InstructionTextProps {
  /** The step, exactly as stored. */
  step: string;
  /** The step's own text style — inherited by the prose and the temperatures. */
  style?: StyleProp<TextStyle>;
}

export default function InstructionText({ step, style }: InstructionTextProps) {
  const segments = useMemo(() => splitStepTemperatures(step), [step]);

  // Which temperatures the reader has flipped to the other scale, keyed by
  // segment index. A different step means different segments, so a reused
  // component instance (same list position, new recipe) must start fresh.
  const [converted, setConverted] = useState<Record<number, boolean>>({});
  useEffect(() => setConverted({}), [step]);

  // No temperature to tap — the overwhelmingly common step — renders as the
  // plain <Text> it was before, with none of the per-token machinery.
  const hasTemperature = useMemo(() => segments.some((s) => s.temp), [segments]);
  if (!hasTemperature) return <Text style={style}>{step}</Text>;

  const toggle = (index: number, event: GestureResponderEvent) => {
    // Keep the tap from also reaching an enclosing pressable — in cook mode the
    // step itself is a "mark done" target, and reading a temperature is not that.
    event.stopPropagation?.();
    Haptics.selectionAsync().catch(() => {});
    setConverted((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  return (
    <Text style={style}>
      {segments.map((segment, index) => {
        if (!segment.temp) return <Text key={index}>{segment.text}</Text>;

        const isConverted = !!converted[index];
        const written = formatTemperature(segment.temp);
        const other = formatTemperature(convertTemperature(segment.temp));
        // What's on screen now, and what a tap would switch it to.
        const shown = isConverted ? other : written;
        const alternate = isConverted ? written : other;

        return (
          <Text
            key={index}
            onPress={(event) => toggle(index, event)}
            suppressHighlighting
            style={[styles.temp, isConverted && styles.tempConverted]}
            accessibilityRole="button"
            accessibilityLabel={`${shown}. Tap to read it as ${alternate}.`}
          >
            {shown}
          </Text>
        );
      })}
    </Text>
  );
}

const styles = StyleSheet.create({
  // Coloured and underlined so it reads as tappable inside a run of prose —
  // the inline echo of the ingredient rows' swap affordance, which has room for
  // an icon where a sentence does not.
  temp: { color: primary, fontWeight: '700', textDecorationLine: 'underline' },
  // Once flipped, a faint tint marks the reading as the app's conversion rather
  // than what the recipe wrote — the same "this isn't the original" signal the
  // converted ingredient amounts carry.
  tempConverted: { backgroundColor: accentSoft },
});
