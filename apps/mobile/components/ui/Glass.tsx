import { canvas, glassBorder, glassShadow } from '@/utils/styles';
import { BlurView, type BlurTint } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { AccessibilityInfo, Platform, Pressable, type PressableProps, StyleSheet, View, type ViewProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

const Preferences = createContext({ reduceMotion: false, reduceTransparency: false });

/** Keep system accessibility preferences live while the app is running. */
export function GlassPreferencesProvider({ children }: { children: React.ReactNode }) {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [reduceTransparency, setReduceTransparency] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then(value => active && setReduceMotion(value));
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    if (Platform.OS === 'ios') {
      AccessibilityInfo.isReduceTransparencyEnabled().then(value => active && setReduceTransparency(value));
    }
    const transparency = Platform.OS === 'ios'
      ? AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduceTransparency)
      : undefined;
    return () => { active = false; motion.remove(); transparency?.remove(); };
  }, []);
  return <Preferences.Provider value={{ reduceMotion, reduceTransparency }}>{children}</Preferences.Provider>;
}

export const useGlassPreferences = () => useContext(Preferences);

type GlassSurfaceProps = ViewProps & { intensity?: number; tint?: BlurTint };

/** Native iOS blur, with a luminous rim and an opaque accessibility fallback. */
export function GlassSurface({ children, style, intensity = 55, tint = 'light', ...props }: GlassSurfaceProps) {
  const { reduceTransparency } = useGlassPreferences();
  const flattened = StyleSheet.flatten(style);
  const radius = flattened?.borderRadius ?? 28;
  const corners: ViewStyle = {
    borderRadius: radius,
    borderTopLeftRadius: flattened?.borderTopLeftRadius ?? radius,
    borderTopRightRadius: flattened?.borderTopRightRadius ?? radius,
    borderBottomLeftRadius: flattened?.borderBottomLeftRadius ?? radius,
    borderBottomRightRadius: flattened?.borderBottomRightRadius ?? radius,
    borderCurve: 'continuous',
  };
  return (
    <View {...props} style={[styles.surface, style, reduceTransparency && styles.opaque]}>
      {!reduceTransparency && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, corners, { overflow: 'hidden', zIndex: -1 }]}>
          <BlurView intensity={intensity} tint={tint} style={[StyleSheet.absoluteFill, corners, { overflow: 'hidden' }]} />
          <View style={[StyleSheet.absoluteFill, styles.wash, corners]} />
        </View>
      )}
      {children}
    </View>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
type GlassPressableProps = Omit<PressableProps, 'style' | 'children'> & {
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  haptic?: boolean;
};

/** A small, interruptible spring makes every touch feel direct. */
export function GlassPressable({ children, style, haptic = true, disabled, onPressIn, onPressOut, accessibilityRole = 'button', ...props }: GlassPressableProps) {
  const scale = useSharedValue(1);
  const { reduceMotion } = useGlassPreferences();
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const spring = (value: number) => {
    scale.value = reduceMotion ? 1 : withSpring(value, { damping: 18, stiffness: 350, mass: 0.55, reduceMotion: ReduceMotion.System });
  };
  return (
    <AnimatedPressable
      {...props}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ ...props.accessibilityState, disabled: !!disabled }}
      style={[style, animatedStyle, disabled && { opacity: 0.5 }]}
      onPressIn={event => {
        spring(0.96);
        if (haptic && Platform.OS === 'ios') Haptics.selectionAsync().catch(() => {});
        onPressIn?.(event);
      }}
      onPressOut={event => { spring(1); onPressOut?.(event); }}
    >
      {children}
    </AnimatedPressable>
  );
}

export function AmbientBackground({ children, style, ...props }: ViewProps) {
  return (
    <View {...props} style={[styles.ambient, style]}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={styles.mintGlow} />
        <View style={styles.peachGlow} />
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  surface: { zIndex: 0, borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.48)', borderWidth: 1, borderColor: glassBorder, boxShadow: glassShadow },
  wash: { backgroundColor: 'rgba(255,255,255,0.16)' },
  opaque: { backgroundColor: '#FDFEF9' },
  ambient: { flex: 1, backgroundColor: canvas, overflow: 'hidden' },
  mintGlow: { position: 'absolute', width: 430, height: 430, borderRadius: 215, backgroundColor: 'rgba(198,225,205,0.32)', right: -240, top: -190 },
  peachGlow: { position: 'absolute', width: 340, height: 340, borderRadius: 170, backgroundColor: 'rgba(239,209,185,0.14)', left: -250, top: 340 },
});
