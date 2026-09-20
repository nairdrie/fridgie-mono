import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useState } from 'react';
import { Keyboard, Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { ink, inkMuted, primary } from '@/utils/styles';
import { GlassPressable, GlassSurface, useGlassPreferences } from './Glass';

const tabs = {
  list: { label: 'Plan', icon: 'calendar-outline', active: 'calendar' },
  explore: { label: 'Discover', icon: 'compass-outline', active: 'compass' },
  profile: { label: 'You', icon: 'person-outline', active: 'person' },
} as const;

export default function GlassTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const [width, setWidth] = useState(0);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const { reduceMotion } = useGlassPreferences();
  const position = useSharedValue(state.index);
  const routes = state.routes.filter(route => route.name in tabs);
  const activeIndex = routes.findIndex(route => route.key === state.routes[state.index].key);
  const segment = (width - 12) / routes.length;
  useEffect(() => {
    position.value = reduceMotion ? activeIndex : withSpring(activeIndex, { damping: 22, stiffness: 240, mass: 0.8, reduceMotion: ReduceMotion.System });
  }, [activeIndex, position, reduceMotion]);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const activeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: position.value * segment }] }));
  if (keyboardVisible) return null;
  return (
    <View pointerEvents="box-none" style={[styles.container, { bottom: Math.max(insets.bottom, 14) }]}>
      <GlassSurface intensity={80} style={styles.dock} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
        {width > 0 && <Animated.View pointerEvents="none" style={[styles.selection, { width: segment }, activeStyle]} />}
        {routes.map((route, index) => {
          const selected = index === activeIndex;
          const config = tabs[route.name as keyof typeof tabs];
          const { options } = descriptors[route.key];
          return (
            <GlassPressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityLabel={options.tabBarAccessibilityLabel ?? config.label}
              accessibilityState={{ selected }}
              style={styles.tab}
              onPress={() => {
                const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!selected && !event.defaultPrevented) navigation.navigate(route.name, route.params);
              }}
              onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
            >
              <View>
                <Ionicons name={selected ? config.active : config.icon} size={23} color={selected ? primary : inkMuted} />
                {options.tabBarBadge !== undefined && <View style={styles.badge}><Text style={styles.badgeText}>{options.tabBarBadge}</Text></View>}
              </View>
              <Text style={[styles.label, selected && styles.selectedLabel]}>{config.label}</Text>
            </GlassPressable>
          );
        })}
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'absolute', left: 28, right: 28, alignItems: 'center' },
  dock: { width: '100%', maxWidth: 380, height: 74, borderRadius: 38, padding: 6, flexDirection: 'row', alignItems: 'center', boxShadow: '0 10px 34px rgba(23,63,53,0.16)', backgroundColor: 'rgba(255,255,255,0.6)' },
  selection: { position: 'absolute', left: 5, top: 5, bottom: 5, borderRadius: 32, backgroundColor: 'rgba(212,233,219,0.8)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.9)' },
  tab: { flex: 1, minHeight: 60, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 30 },
  label: { fontSize: 11, fontWeight: '600', color: inkMuted, letterSpacing: 0.1 },
  selectedLabel: { color: ink, fontWeight: '700' },
  badge: { position: 'absolute', top: -5, right: -10, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 3, backgroundColor: '#C4664C', alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 9, color: 'white', fontWeight: '700' },
});
