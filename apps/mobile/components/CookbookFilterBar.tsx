// components/CookbookFilterBar.tsx
//
// The row of category chips under a cookbook's search box, plus the control
// that says what order the shelf is in.
//
// Chips rather than a dropdown of categories because the counts are half the
// point — "I have eleven mains and two puddings" is worth knowing before you
// tap anything, and it is the difference between a filter you use and one you
// forget is there.

import { CategoryChip, CategoryFilter, COOKBOOK_SORTS, CookbookSort, sortLabel } from '@/utils/cookbookFilter';
import { hairline, ink, inkFaint, inkMuted, primary } from '@/utils/styles';
import { GlassPressable, GlassSurface, useGlassPreferences } from '@/components/ui/Glass';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import {
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';

interface CookbookFilterBarProps {
    chips: CategoryChip[];
    selected: CategoryFilter;
    onSelect: (category: CategoryFilter) => void;
    sort: CookbookSort;
    onSortChange: (sort: CookbookSort) => void;
    /** Off where the list is somebody else's to order — a picker, not a shelf. */
    showSort?: boolean;
}

export default function CookbookFilterBar({
    chips,
    selected,
    onSelect,
    sort,
    onSortChange,
    showSort = true,
}: CookbookFilterBarProps) {
    const [isSortOpen, setSortOpen] = useState(false);
    const insets = useSafeAreaInsets();
    const { reduceMotion } = useGlassPreferences();

    // A cookbook with everything on one shelf has nothing to filter and nothing
    // to reorder; the bar would be pure furniture.
    if (chips.length === 0) return null;

    return (
        <View style={styles.container}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.chipRow}
            >
                {chips.map((chip) => {
                    const isSelected = chip.key === selected;
                    return (
                        <GlassPressable
                            key={chip.key}
                            style={[styles.chip, isSelected && styles.chipSelected]}
                            onPress={() => onSelect(chip.key)}
                            accessibilityRole="button"
                            accessibilityState={{ selected: isSelected }}
                            accessibilityLabel={`${chip.label}, ${chip.count} recipes`}
                        >
                            <Text style={[styles.chipLabel, isSelected && styles.chipLabelSelected]}>
                                {chip.label}
                            </Text>
                            <Text style={[styles.chipCount, isSelected && styles.chipCountSelected]}>
                                {chip.count}
                            </Text>
                        </GlassPressable>
                    );
                })}
            </ScrollView>

            {showSort && (
                <GlassPressable
                    style={styles.sortButton}
                    onPress={() => setSortOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel={`Sort: ${sortLabel(sort)}`}
                >
                    <Ionicons name="swap-vertical" size={18} color={inkMuted} />
                </GlassPressable>
            )}

            <Modal
                visible={isSortOpen}
                transparent
                animationType={reduceMotion ? "none" : "fade"}
                onRequestClose={() => setSortOpen(false)}
            >
                <Pressable style={styles.sheetBackdrop} onPress={() => setSortOpen(false)}>
                    {/* Swallows a tap on the sheet itself, which would otherwise
                        reach the backdrop behind it and close it mid-choice. */}
                    <Pressable onPress={() => {}} accessibilityViewIsModal>
                    <GlassSurface style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 24) }]} intensity={90}>
                        <View style={styles.sheetHandle} />
                        <View style={styles.sheetHeading}>
                            <View style={{ flex: 1 }}><Text style={styles.sheetEyebrow}>YOUR COOKBOOK</Text><Text style={styles.sheetTitle}>Just how you like it</Text></View>
                            <GlassPressable style={styles.sheetClose} onPress={() => setSortOpen(false)} accessibilityRole="button" accessibilityLabel="Close sorting options"><Ionicons name="close" size={20} color={ink} /></GlassPressable>
                        </View>
                        {COOKBOOK_SORTS.map((option) => {
                            const isCurrent = option.key === sort;
                            return (
                                <GlassPressable
                                    key={option.key}
                                    style={[styles.sheetOption, isCurrent && styles.sheetOptionCurrent]}
                                    onPress={() => {
                                        onSortChange(option.key);
                                        setSortOpen(false);
                                    }}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: isCurrent }}
                                    accessibilityLabel={`Sort by ${option.label}`}
                                >
                                    <Text style={[styles.sheetOptionText, isCurrent && styles.sheetOptionTextCurrent]}>
                                        {option.label}
                                    </Text>
                                    <View style={[styles.selectionDot, isCurrent && styles.selectionDotCurrent]}>{isCurrent && <Ionicons name="checkmark" size={14} color="#FFF" />}</View>
                                </GlassPressable>
                            );
                        })}
                    </GlassSurface>
                    </Pressable>
                </Pressable>
            </Modal>
        </View>
    );
}

/**
 * The heading above each group when the cookbook is read by category.
 *
 * Lives here rather than in each screen because both cookbook screens draw it
 * and it is the same piece of furniture as the chips — a shelf label.
 */
export function CookbookGroupHeader({ category, count }: { category: string; count: number }) {
    return (
        <View style={styles.groupHeader}>
            <Text style={styles.groupHeaderText}>{category}</Text>
            <Text style={styles.groupHeaderCount}>{count}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flexDirection: 'row', alignItems: 'center', marginBottom: 18 },
    chipRow: { gap: 8, paddingRight: 8 },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14, minHeight: 42, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 1, borderColor: '#FFF' },
    chipSelected: { backgroundColor: primary, borderColor: primary },
    chipLabel: { fontSize: 12, fontWeight: '600', color: ink },
    chipLabelSelected: { color: '#FFF' },
    chipCount: { fontSize: 10, fontWeight: '600', color: inkMuted, backgroundColor: '#EAF0E6', paddingHorizontal: 6, paddingVertical: 3, overflow: 'hidden', borderRadius: 9 },
    chipCountSelected: { color: '#FFF', backgroundColor: 'rgba(255,255,255,0.18)' },
    sortButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.85)', borderWidth: 1, borderColor: '#FFF', marginLeft: 5 },
    sheetBackdrop: { flex: 1, backgroundColor: 'rgba(17,42,32,0.25)', justifyContent: 'flex-end', padding: 10 },
    sheet: { borderRadius: 32, paddingTop: 10, paddingHorizontal: 20 },
    sheetHandle: { width: 34, height: 4, borderRadius: 2, alignSelf: 'center', backgroundColor: '#C0CABF', marginBottom: 21 },
    sheetHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 21, gap: 8 },
    sheetEyebrow: { fontSize: 9, letterSpacing: 1.8, fontWeight: '700', color: inkMuted, marginBottom: 5 },
    sheetTitle: { fontSize: 23, fontWeight: '700', letterSpacing: -0.7, color: ink },
    sheetClose: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#E7EDE4', justifyContent: 'center', alignItems: 'center' },
    sheetOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 58, borderRadius: 18, paddingHorizontal: 15, marginBottom: 5 },
    sheetOptionCurrent: { backgroundColor: '#DCEDE2' },
    sheetOptionText: { fontSize: 16, color: ink },
    sheetOptionTextCurrent: { color: primary, fontWeight: '700' },
    selectionDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: hairline, alignItems: 'center', justifyContent: 'center' },
    selectionDotCurrent: { backgroundColor: primary, borderColor: primary },
    groupHeader: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 13, marginBottom: 13 },
    groupHeaderText: { fontSize: 19, fontWeight: '700', letterSpacing: -0.5, color: ink },
    groupHeaderCount: { fontSize: 12, fontWeight: '500', color: inkFaint },
});
