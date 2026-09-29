// components/FiledToast.tsx
//
// The note that says where an item went when the list filed it into an aisle.
//
// Filing moves a row from the bottom of the list up under a heading that may
// be well off screen, and without a word it reads as the item vanishing. This
// names the aisle; tapping it scrolls there, and its ✕ is the way to say
// "leave it where I put it".

import { ink, inkMuted, primary } from '@/utils/styles';
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp, ReduceMotion } from 'react-native-reanimated';
import { GlassPressable, GlassSurface } from './ui/Glass';

export interface FiledToastInfo {
    /** Bumped for every filing pass, so a second note replaces the first. */
    key: number;
    /** What the note says went where, already worded. */
    itemLabel: string;
    section: string | null;
    count: number;
}

interface FiledToastProps {
    toast: FiledToastInfo | null;
    /** Scroll to where the rows went. */
    onShow: () => void;
    /** Take the filed rows back out of their aisle, to the bottom of the list. */
    onUnfile: () => void;
}

const FiledToast = ({ toast, onShow, onUnfile }: FiledToastProps) => {
    // box-none throughout: the note floats over the top of the list, and
    // everything around the pill itself still has to reach the rows beneath.
    return (
        <View pointerEvents="box-none" style={styles.anchor}>
            {toast && (
                <Animated.View
                    key={toast.key}
                    pointerEvents="box-none"
                    entering={FadeInUp.springify().damping(18).stiffness(180).reduceMotion(ReduceMotion.System)}
                    exiting={FadeOutUp.duration(180).reduceMotion(ReduceMotion.System)}
                >
                    <GlassSurface style={styles.pill} intensity={70}>
                        {/* The message and the ✕ are sibling buttons rather
                            than one inside the other: an accessible parent
                            hides its children from VoiceOver, which would
                            leave no way to reach the ✕. */}
                        <Pressable
                            onPress={onShow}
                            hitSlop={{ top: 6, bottom: 6, left: 10 }}
                            style={({ pressed }) => [styles.show, pressed && styles.pressed]}
                            accessibilityRole="button"
                            accessibilityLabel={toast.section
                                ? `${toast.itemLabel} moved to ${toast.section}`
                                : `${toast.itemLabel} sorted into aisles`}
                            accessibilityHint="Scrolls to where it went"
                            accessibilityLiveRegion="polite"
                        >
                            <Ionicons name="arrow-up-circle" size={18} color={primary} />
                            <Text style={styles.message} numberOfLines={1}>
                                {toast.section ? (
                                    <>
                                        <Text style={styles.strong}>{toast.itemLabel}</Text>
                                        {' moved to '}
                                        <Text style={styles.section}>{toast.section}</Text>
                                    </>
                                ) : (
                                    <>
                                        <Text style={styles.strong}>{toast.itemLabel}</Text>
                                        {' sorted into aisles'}
                                    </>
                                )}
                            </Text>
                        </Pressable>
                        <GlassPressable
                            onPress={onUnfile}
                            hitSlop={10}
                            style={styles.unfile}
                            accessibilityLabel={toast.count === 1
                                ? `Keep ${toast.itemLabel} uncategorized`
                                : 'Keep these items uncategorized'}
                            accessibilityHint="Moves it back to the bottom of the list"
                        >
                            <Ionicons name="close" size={15} color={inkMuted} />
                        </GlassPressable>
                    </GlassSurface>
                </Animated.View>
            )}
        </View>
    );
};

export default FiledToast;

const styles = StyleSheet.create({
    anchor: { position: 'absolute', top: 6, left: 20, right: 20, alignItems: 'center' },
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        maxWidth: '100%',
        paddingLeft: 12,
        paddingRight: 5,
        paddingVertical: 5,
        borderRadius: 999,
        shadowColor: '#173F35',
        shadowOpacity: 0.12,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 6 },
        elevation: 4,
    },
    show: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, paddingVertical: 2 },
    pressed: { opacity: 0.6 },
    message: { flexShrink: 1, fontSize: 13, color: inkMuted },
    strong: { fontWeight: '600', color: ink },
    section: { fontWeight: '600', color: primary },
    unfile: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(23,63,53,0.06)' },
});
