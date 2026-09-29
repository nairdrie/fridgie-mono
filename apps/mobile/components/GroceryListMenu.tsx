// components/GroceryListMenu.tsx
//
// The grocery list's ⋯ menu: undo and redo, whether to show which meal each
// item is for, and folding every aisle at once.
//
// One small button in place of a row of them. None of these is needed on
// every visit, and the top of the list is where the shopping progress lives —
// it should read as a summary, not a toolbar.

import { hairline, ink, inkFaint, inkMuted, primary } from '@/utils/styles';
import { Ionicons } from '@expo/vector-icons';
import React, { useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { GlassPressable, GlassSurface } from './ui/Glass';

interface GroceryListMenuProps {
    /** What undo would take back, e.g. "Check milk". Null when there is nothing. */
    undoLabel: string | null;
    redoLabel: string | null;
    onUndo: () => void;
    onRedo: () => void;
    /** Absent when nothing on the list came from a meal, so there is nothing to show. */
    mealTags?: { shown: boolean; onToggle: () => void };
    /** Absent when the list has no aisles yet. */
    aisles?: { allFolded: boolean; onFoldAll: () => void; onUnfoldAll: () => void };
}

const MENU_WIDTH = 260;

export default function GroceryListMenu({ undoLabel, redoLabel, onUndo, onRedo, mealTags, aisles }: GroceryListMenuProps) {
    const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
    const buttonRef = useRef<View>(null);
    const { width } = useWindowDimensions();

    const open = () => {
        buttonRef.current?.measureInWindow((x, y, w, h) => {
            setAnchor({ top: y + h + 6, right: Math.max(12, width - (x + w)) });
        });
    };
    const close = () => setAnchor(null);
    // Every choice but undo/redo closes the menu. Those two stay open so you
    // can step back through several changes without reopening it each time.
    const choose = (action: () => void) => () => { close(); action(); };

    return (
        <>
            <View ref={buttonRef} collapsable={false}>
            <GlassPressable
                onPress={open}
                hitSlop={8}
                style={[styles.button, anchor && styles.buttonOpen]}
                accessibilityLabel="List options"
                accessibilityHint="Undo, redo, show meals, fold aisles"
            >
                <Ionicons name="ellipsis-horizontal" size={18} color={anchor ? primary : inkMuted} />
            </GlassPressable>
            </View>

            <Modal visible={!!anchor} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
                <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close list options" />
                {anchor && (
                    <Animated.View
                        entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)}
                        exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
                        style={[styles.menuAnchor, { top: anchor.top, right: anchor.right }]}
                    >
                        <GlassSurface style={styles.menu} intensity={80}>
                            <View style={styles.historyRow}>
                                <HistoryButton icon="arrow-undo" title="Undo" detail={undoLabel} onPress={onUndo} />
                                <View style={styles.historyDivider} />
                                <HistoryButton icon="arrow-redo" title="Redo" detail={redoLabel} onPress={onRedo} />
                            </View>

                            {mealTags && (
                                <MenuRow
                                    icon="restaurant-outline"
                                    title="Show meal names"
                                    checked={mealTags.shown}
                                    onPress={choose(mealTags.onToggle)}
                                />
                            )}
                            {aisles && (
                                <MenuRow
                                    icon={aisles.allFolded ? 'chevron-expand' : 'chevron-collapse'}
                                    title={aisles.allFolded ? 'Expand all aisles' : 'Collapse all aisles'}
                                    onPress={choose(aisles.allFolded ? aisles.onUnfoldAll : aisles.onFoldAll)}
                                />
                            )}
                        </GlassSurface>
                    </Animated.View>
                )}
            </Modal>
        </>
    );
}

function HistoryButton({ icon, title, detail, onPress }: {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    title: string;
    detail: string | null;
    onPress: () => void;
}) {
    const disabled = !detail;
    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            style={({ pressed }) => [styles.historyButton, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            accessibilityLabel={detail ? `${title}: ${detail}` : `Nothing to ${title.toLowerCase()}`}
        >
            <Ionicons name={icon} size={19} color={disabled ? hairline : primary} />
            <Text style={[styles.historyTitle, disabled && styles.disabledText]}>{title}</Text>
            {/* Says what it will do, so a tap is never a guess. */}
            <Text style={styles.historyDetail} numberOfLines={1}>{detail ?? ' '}</Text>
        </Pressable>
    );
}

function MenuRow({ icon, title, checked, onPress }: {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    title: string;
    /** Present for a setting that is on or off. */
    checked?: boolean;
    onPress: () => void;
}) {
    return (
        <Pressable
            onPress={onPress}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            accessibilityRole={checked === undefined ? 'button' : 'switch'}
            accessibilityState={checked === undefined ? undefined : { checked }}
        >
            <Ionicons name={icon} size={18} color={inkMuted} />
            <Text style={styles.rowTitle}>{title}</Text>
            {checked !== undefined && (
                <Ionicons name={checked ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={checked ? primary : inkFaint} />
            )}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    button: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: hairline },
    buttonOpen: { borderColor: 'transparent', backgroundColor: 'rgba(35, 120, 94, 0.09)' },
    menuAnchor: { position: 'absolute', width: MENU_WIDTH },
    menu: {
        borderRadius: 20,
        overflow: 'hidden',
        shadowColor: '#173F35',
        shadowOpacity: 0.16,
        shadowRadius: 22,
        shadowOffset: { width: 0, height: 10 },
        elevation: 8,
    },
    historyRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: hairline },
    historyDivider: { width: StyleSheet.hairlineWidth, backgroundColor: hairline },
    historyButton: { flex: 1, alignItems: 'center', paddingTop: 12, paddingBottom: 10, paddingHorizontal: 8, gap: 2 },
    historyTitle: { fontSize: 14, fontWeight: '600', color: ink, marginTop: 2 },
    historyDetail: { fontSize: 11, color: inkFaint, maxWidth: '100%' },
    disabledText: { color: inkFaint },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: hairline },
    rowTitle: { flex: 1, fontSize: 15, color: ink },
    pressed: { backgroundColor: 'rgba(23,63,53,0.06)' },
});
