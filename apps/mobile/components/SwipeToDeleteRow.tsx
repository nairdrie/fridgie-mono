// components/SwipeToDeleteRow.tsx
//
// A list row you can swipe away, the way iOS has taught people rows behave:
// dragging left reveals a Delete panel that follows the finger, and carrying the
// row far enough across deletes it outright on release, with a haptic tick at
// the point of no return. The ✕ on the row does the same job for anyone who
// never thinks to swipe, so this is an extra way in rather than a replacement.

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useRef } from 'react';
import { LayoutChangeEvent, Platform, Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, {
    runOnJS,
    SharedValue,
    useAnimatedReaction,
    useAnimatedStyle,
    useSharedValue,
} from 'react-native-reanimated';

/** Width of the Delete panel a partial swipe comes to rest on. */
const ACTION_WIDTH = 76;

/** Carry the row this far across it and letting go deletes it. */
const FULL_SWIPE_FRACTION = 0.45;

/**
 * The row currently showing its Delete panel, if any. iOS only ever leaves one
 * open; closing the previous one is what keeps the list readable.
 *
 * Module scope on purpose — every row shares the one slot.
 */
const openRow: { current: SwipeableMethods | null } = { current: null };

/**
 * The red panel behind the row. Pinned to the right edge and sized from the
 * drag, so the colour follows the finger all the way across instead of sitting
 * at a fixed width behind the row.
 */
function DeleteAction({ translation, fullSwipeAt, onArmedChange, onPress }: {
    translation: SharedValue<number>;
    fullSwipeAt: SharedValue<number>;
    onArmedChange: (armed: boolean) => void;
    onPress: () => void;
}) {
    const panelStyle = useAnimatedStyle(() => ({
        width: Math.max(ACTION_WIDTH, -translation.value),
    }));

    useAnimatedReaction(
        // Zero until the row has been measured: with no width to compare
        // against there is no full swipe, only the panel.
        () => fullSwipeAt.value > 0 && -translation.value >= fullSwipeAt.value,
        (armed, wasArmed) => {
            if (wasArmed === null || armed === wasArmed) return;
            runOnJS(onArmedChange)(armed);
        }
    );

    return (
        <Animated.View style={[styles.action, panelStyle]}>
            <Pressable
                onPress={onPress}
                style={styles.actionButton}
                accessibilityRole="button"
                accessibilityLabel="Delete"
            >
                <Ionicons name="trash-outline" size={20} color="#fff" />
            </Pressable>
        </Animated.View>
    );
}

interface SwipeToDeleteRowProps {
    onDelete: () => void;
    /** Off while the row is being dragged — one gesture on a row at a time. */
    enabled?: boolean;
    children: React.ReactNode;
}

export default function SwipeToDeleteRow({ onDelete, enabled = true, children }: SwipeToDeleteRowProps) {
    const swipeableRef = useRef<SwipeableMethods | null>(null);
    const fullSwipeAt = useSharedValue(0);
    // Whether the drag is past the point of no return *right now*. Read from the
    // release callback, which runs on the JS thread a moment later — by then the
    // shared value has already been carried back by the settling animation, so
    // the answer is kept here rather than read off the UI thread.
    const isArmed = useRef(false);

    const handleArmedChange = useCallback((armed: boolean) => {
        isArmed.current = armed;
        // The tick that says "let go now and it's gone".
        if (armed) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }, []);

    const remove = useCallback(() => {
        isArmed.current = false;
        if (openRow.current === swipeableRef.current) openRow.current = null;
        onDelete();
    }, [onDelete]);

    const measure = useCallback((event: LayoutChangeEvent) => {
        fullSwipeAt.value = event.nativeEvent.layout.width * FULL_SWIPE_FRACTION;
    }, [fullSwipeAt]);

    useEffect(() => () => {
        // A row deleted while open would otherwise leave the slot pointing at a
        // swipeable that no longer exists.
        if (openRow.current === swipeableRef.current) openRow.current = null;
    }, []);

    // Web is rendered without a GestureHandlerRootView (see app/_layout.tsx) and
    // has no swipe to speak of: the row renders plain and the ✕ deletes.
    if (Platform.OS === 'web') return <>{children}</>;

    return (
        <View onLayout={measure}>
            <ReanimatedSwipeable
                ref={swipeableRef}
                enabled={enabled}
                friction={1}
                rightThreshold={ACTION_WIDTH / 2}
                overshootRight
                childrenContainerStyle={styles.row}
                onSwipeableWillOpen={() => {
                    if (isArmed.current) {
                        remove();
                        return;
                    }
                    if (openRow.current && openRow.current !== swipeableRef.current) {
                        openRow.current.close();
                    }
                    openRow.current = swipeableRef.current;
                }}
                onSwipeableWillClose={() => {
                    if (openRow.current === swipeableRef.current) openRow.current = null;
                }}
                renderRightActions={(_progress, translation, methods) => (
                    <DeleteAction
                        translation={translation}
                        fullSwipeAt={fullSwipeAt}
                        onArmedChange={handleArmedChange}
                        onPress={() => {
                            methods.close();
                            remove();
                        }}
                    />
                )}
            >
                {children}
            </ReanimatedSwipeable>
        </View>
    );
}

const styles = StyleSheet.create({
    // Opaque, or the panel behind shows straight through the row it is meant to
    // be revealed by.
    row: { backgroundColor: '#fff' },
    action: { backgroundColor: '#FF3B30', alignItems: 'flex-end', justifyContent: 'center' },
    // Fixed width inside a panel that grows, so the icon stays put against the
    // right edge rather than drifting with the drag.
    actionButton: { width: ACTION_WIDTH, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
});
