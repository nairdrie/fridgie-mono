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
import { hairline, ink, inkFaint, inkMuted, primary, surface } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import {
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
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
                        <TouchableOpacity
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
                        </TouchableOpacity>
                    );
                })}
            </ScrollView>

            {showSort && (
                <TouchableOpacity
                    style={styles.sortButton}
                    onPress={() => setSortOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel={`Sort: ${sortLabel(sort)}`}
                >
                    <Ionicons name="swap-vertical" size={18} color={inkMuted} />
                </TouchableOpacity>
            )}

            <Modal
                visible={isSortOpen}
                transparent
                animationType="fade"
                onRequestClose={() => setSortOpen(false)}
            >
                <Pressable style={styles.sheetBackdrop} onPress={() => setSortOpen(false)}>
                    {/* Swallows a tap on the sheet itself, which would otherwise
                        reach the backdrop behind it and close it mid-choice. */}
                    <Pressable style={styles.sheet} onPress={() => {}}>
                        <Text style={styles.sheetTitle}>Sort by</Text>
                        {COOKBOOK_SORTS.map((option) => {
                            const isCurrent = option.key === sort;
                            return (
                                <TouchableOpacity
                                    key={option.key}
                                    style={styles.sheetOption}
                                    onPress={() => {
                                        onSortChange(option.key);
                                        setSortOpen(false);
                                    }}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: isCurrent }}
                                >
                                    <Text style={[styles.sheetOptionText, isCurrent && styles.sheetOptionTextCurrent]}>
                                        {option.label}
                                    </Text>
                                    {isCurrent && <Ionicons name="checkmark" size={20} color={primary} />}
                                </TouchableOpacity>
                            );
                        })}
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
    container: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
    chipRow: { gap: 8, paddingRight: 8 },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 999,
        backgroundColor: surface,
    },
    chipSelected: { backgroundColor: primary },
    chipLabel: { fontSize: 13, fontWeight: '600', color: ink },
    chipLabelSelected: { color: '#fff' },
    chipCount: { fontSize: 12, fontWeight: '600', color: inkMuted },
    chipCountSelected: { color: 'rgba(255, 255, 255, 0.75)' },
    sortButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: surface,
        borderWidth: 1,
        borderColor: hairline,
        marginLeft: 4,
    },
    sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.35)', justifyContent: 'flex-end' },
    sheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 20, paddingBottom: 36, paddingHorizontal: 20 },
    sheetTitle: { fontSize: 13, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', color: inkMuted, marginBottom: 8 },
    sheetOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: hairline },
    sheetOptionText: { fontSize: 16, color: ink },
    sheetOptionTextCurrent: { color: primary, fontWeight: '700' },
    groupHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, marginBottom: 8 },
    groupHeaderText: { fontSize: 13, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', color: inkMuted },
    groupHeaderCount: { fontSize: 12, fontWeight: '600', color: inkFaint },
});
