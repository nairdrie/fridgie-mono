// components/GroceryListView.tsx

import { Item } from '@/types/types';
import {
    aggregateQuantities,
    convert,
    formatQuantity,
    parseQuantity,
    parseQuantityAndText,
    quantitiesEquivalent,
} from '@/utils/quantity';
import { nextListRank, safeParseRank } from '@/utils/rank';
import { primary } from '@/utils/styles';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LexoRank } from 'lexorank';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
    Keyboard,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import uuid from 'react-native-uuid';
import QuantityEditorModal from './QuantityEditorModal';
import SwipeToDeleteRow from './SwipeToDeleteRow';

type AggregatedItem = Item & {
 sourceIds: string[];
 totalQuantity: string;
};

/** What the screen can ask of the list, via its ref. */
export interface GroceryListHandle {
  /** Bring the row holding `itemId` into view, if it is on screen at all. */
  scrollToItemId: (itemId: string) => void;
}

// --- COMPONENT PROPS ---
interface GroceryListViewProps {
  items: Item[];
  setItems: React.Dispatch<React.SetStateAction<Item[]>>;
  editingId: string;
  setEditingId: React.Dispatch<React.SetStateAction<string>>;
  inputRefs: React.MutableRefObject<Record<string, TextInput | null>>;
  isKeyboardVisible: boolean;
  markDirty: () => void;
  /**
   * The user has just put a row somewhere by hand. Filing runs constantly in
   * the background, and an answer that was worked out before this happened
   * would put the row back; the screen uses this to throw such an answer away.
   */
  onManualReorder?: () => void;
}

const GroceryListView = forwardRef<GroceryListHandle, GroceryListViewProps>(({
    items,
    setItems,
    editingId,
    setEditingId,
    inputRefs,
    isKeyboardVisible,
    markDirty,
    onManualReorder,
}, ref) => {
    const [isModalVisible, setIsModalVisible] = useState(false);
    const [selectedItem, setSelectedItem] = useState<AggregatedItem | null>(null);
    // Checked items are put away, not shown crossed out in place, so the section
    // starts closed — opening it is asking to see what you already have.
    const [showChecked, setShowChecked] = useState(false);

    const aggregatedItems = useMemo((): (AggregatedItem | Item)[] => {
        const itemMap = new Map<string, Item[]>();
        const sections: Item[] = [];

        for (const item of items) {
            if (item.isSection) {
                sections.push(item);
                continue;
            }
            // `?? ''` rather than `.trim()` on the raw field: a row that reached
            // us without text is a rendering bug at worst, but reading through
            // undefined here throws mid-render and takes the whole screen with it.
            const key = (item.text ?? '').trim().toLowerCase() || `__blank-${item.id}__`;
            if (!itemMap.has(key)) {
                itemMap.set(key, []);
            }
            itemMap.get(key)!.push(item);
        }

        const result: AggregatedItem[] = [];
        for (const [, sources] of itemMap) {
            if (sources.length === 0) continue;
            const baseItem = sources[0];
            // The item name unlocks mass↔volume merging: "1 cup flour" and
            // "10 g flour" can only combine if we know what a cup of flour
            // weighs. Without it they stay separate terms.
            const computedTotal = aggregateQuantities(sources.map(s => s.quantity), baseItem.text);

            // An override replaces the computed total, but only while the
            // underlying quantities still match the snapshot taken when it was
            // set. If meal ingredients changed since, the override is stale and
            // the live computed total wins.
            const overrideSource = sources.find(s => s.overrideQuantity);
            const overrideIsFresh = overrideSource
                && (overrideSource.overrideBase === undefined
                    || quantitiesEquivalent(overrideSource.overrideBase, computedTotal));
            const totalQuantity = overrideIsFresh
                ? overrideSource!.overrideQuantity!
                // If nothing aggregated cleanly, fall back to the base item's own
                // quantity so the chip stays visible and tappable.
                : (computedTotal || baseItem.quantity || '');

            result.push({
                ...baseItem,
                id: `agg-${sources.map(s => s.id).sort().join('-')}`,
                sourceIds: sources.map(s => s.id),
                totalQuantity,
                checked: sources.every(s => s.checked),
            });
        }

        const combined = [...result, ...sections];
        combined.sort((a, b) => (a.listOrder ?? '').localeCompare(b.listOrder ?? ''));
        return combined;
    }, [items]);

    /**
     * The list as it is actually shown: everything still to be bought, and
     * separately everything already in the trolley.
     *
     * A checked item leaves the list and joins the section at the bottom rather
     * than sitting crossed out in the middle of the aisle it came from. Its rank
     * is untouched, so unchecking puts it back exactly where it was.
     *
     * A heading whose items have all been checked goes with them. The server
     * already drops headings it has nothing to file under (see `placeItems`);
     * leaving a run of empty aisles behind on screen would say the same thing
     * twice. A heading with nothing under it at all is one the user has just
     * written and not filled in yet, so that one stays.
     */
    const { openRows, checkedRows } = useMemo(() => {
        const open: (AggregatedItem | Item)[] = [];
        const checked: AggregatedItem[] = [];
        // Backwards, so a heading is reached knowing what survived beneath it.
        let openBelow = 0;
        let rowsBelow = 0;
        for (let i = aggregatedItems.length - 1; i >= 0; i--) {
            const row = aggregatedItems[i];
            if (row.isSection) {
                if (openBelow > 0 || rowsBelow === 0 || editingId === row.id) open.push(row);
                openBelow = 0;
                rowsBelow = 0;
                continue;
            }
            rowsBelow++;
            if (row.checked) {
                checked.push(row as AggregatedItem);
            } else {
                openBelow++;
                open.push(row);
            }
        }
        open.reverse();
        checked.reverse();
        return { openRows: open, checkedRows: checked };
    }, [aggregatedItems, editingId]);

    // Nothing left to put away: next time something is checked the section
    // should open closed again rather than remembering a session-old choice.
    useEffect(() => {
        if (checkedRows.length === 0) setShowChecked(false);
    }, [checkedRows.length]);

    // The FlatList is unmounted whenever the list is empty, so this is null as
    // often as it is set — every use goes through scrollToItemId below.
    const flatListRef = useRef<any>(null);

    useImperativeHandle(ref, () => ({
        scrollToItemId: (itemId: string) => {
            // Rows are aggregates, not items: one row can stand for several
            // item ids, and identical texts collapse into one. Look the id up
            // through that mapping instead of assuming the two arrays line up —
            // scrollToIndex throws on an out-of-range index, and an exception
            // here blanks the screen. A checked row isn't in the list at all.
            const index = openRows.findIndex(row =>
                'sourceIds' in row ? (row as AggregatedItem).sourceIds.includes(itemId) : row.id === itemId);
            if (index < 0 || index >= openRows.length) return;
            flatListRef.current?.scrollToIndex?.({ index, animated: true, viewPosition: 0.5 });
        },
    }), [openRows]);

    const assignRef = useCallback((id: string) => (ref: TextInput | null) => {
        inputRefs.current[id] = ref;
    }, [inputRefs]);

    const updateSectionText = (id: string, text: string) => {
        setItems(prev => prev.map(item => (item.id === id ? { ...item, text } : item)));
        markDirty();
    };

    // Renaming an aggregated row renames every source item (including meal
    // ingredients) so the group stays together instead of splitting mid-keystroke.
    //
    // The aisle on file was decided from the old text, so it goes with it — the
    // list re-files the row once the edit settles.
    const updateAggregatedText = (aggItem: AggregatedItem, text: string) => {
        setItems(prev => prev.map(item => aggItem.sourceIds.includes(item.id)
            ? { ...item, text, section: undefined }
            : item));
        markDirty();
    };

    const toggleCheck = (aggItem: AggregatedItem) => {
        const newCheckedState = !aggItem.checked;
        // The row is about to leave for the section at the bottom (or come back
        // from it), which is a big enough move to want confirming by touch.
        Haptics.selectionAsync().catch(() => {});
        setItems(prev => prev.map(item => aggItem.sourceIds.includes(item.id) ? { ...item, checked: newCheckedState } : item));
        markDirty();
    };

    /** An empty row already waiting for text, if the list has one. */
    const findBlankRow = () => items.find(i => !i.isSection && !i.mealId && (i.text ?? '').trim() === '');

    const addItemAfter = (currentItem?: AggregatedItem | Item) => {
        // Asked for a row on the end: if one is already sitting there empty,
        // that IS the row. Without this every tap on the space below the list
        // stacked up another unlabelled checkbox. Inserting after a specific row
        // is a different request and still gets its own row.
        if (!currentItem) {
            const blank = findBlankRow();
            if (blank) {
                setEditingId(blank.id);
                return;
            }
            const newItem: Item = { id: uuid.v4() as string, text: '', checked: false, listOrder: nextListRank(items).toString(), isSection: false };
            setItems(prev => [...prev, newItem]);
            setEditingId(newItem.id);
            markDirty();
            return;
        }
        const currentIndex = aggregatedItems.findIndex(i => i.id === currentItem.id);
        if (currentIndex === -1) return;

        const currentRank = safeParseRank(aggregatedItems[currentIndex].listOrder) ?? nextListRank(items);
        const nextItem = aggregatedItems[currentIndex + 1];
        const nextRank = nextItem ? safeParseRank(nextItem.listOrder) : null;
        const newRank = nextRank && currentRank.compareTo(nextRank) < 0
            ? currentRank.between(nextRank)
            : currentRank.genNext();
        const newItem: Item = { id: uuid.v4() as string, text: '', checked: false, listOrder: newRank.toString(), isSection: false };
        setItems(prev => [...prev, newItem]);
        setEditingId(newItem.id);
        markDirty();
    };

    // Return on a row with nothing in it is the user finishing, not asking for
    // one more empty row. The empty one they are on gets cleaned up too.
    const submitRow = (currentItem: AggregatedItem | Item) => {
        if (!currentItem.isSection && (currentItem.text ?? '').trim() === '') {
            setEditingId('');
            Keyboard.dismiss();
            return;
        }
        addItemAfter(currentItem);
    };

    /**
     * Removes a row.
     *
     * `focusPrevious` is for the ways of deleting that happen mid-edit —
     * backspacing an empty row, tapping its ✕ — where the caret has to land
     * somewhere and the row above is where it was heading anyway. A swipe is
     * not one of those: it can be aimed at any row on screen, and dragging the
     * keyboard up onto an unrelated one is not what was asked for.
     */
    const deleteItem = (aggItem: AggregatedItem, focusPrevious = false) => {
        // Deletes every source, including meal ingredients — checking and
        // deleting intentionally act on the whole aggregate.
        const sourceIdsToDelete = new Set(aggItem.sourceIds);
        const updatedItems = items.filter(item => !sourceIdsToDelete.has(item.id));
        setItems(updatedItems);
        markDirty();
        if (focusPrevious && isKeyboardVisible) {
            const currentIndex = aggregatedItems.findIndex(i => i.id === aggItem.id);
            const prevItem = aggregatedItems[Math.max(0, currentIndex - 1)];

            if (prevItem && prevItem.id !== aggItem.id) {
                if ('sourceIds' in prevItem) {
                    setEditingId((prevItem as AggregatedItem).sourceIds[0]);
                } else if (prevItem.isSection) {
                    setEditingId(prevItem.id);
                }
            } else {
                setEditingId('');
            }
        } else if (focusPrevious || aggItem.sourceIds.includes(editingId)) {
            // A swipe on some other row leaves the row being typed into alone;
            // only losing the row under the cursor ends the edit.
            setEditingId('');
        }
    };

    const handleItemBlur = (aggItem: AggregatedItem) => {
        const baseItemId = aggItem.sourceIds[0];
        const baseItem = items.find(i => i.id === baseItemId);
        if (!baseItem) return;
        const { quantity, text: newText } = parseQuantityAndText(baseItem.text);
        if (quantity || newText !== baseItem.text) {
            setItems(prev =>
                prev.map(i => {
                    if (!aggItem.sourceIds.includes(i.id)) return i;
                    // Text applies to every source; a typed-in quantity only to the base.
                    const updated = { ...i, text: newText, section: undefined };
                    if (i.id === baseItemId && quantity) updated.quantity = quantity;
                    return updated;
                })
            );
            markDirty();
        }
        setEditingId('');
    };

    /**
     * Puts the rows the list just handed back into the order of the whole list.
     *
     * The draggable list only ever holds the rows on screen, so checked items
     * and the headings hiding with them are missing from `data`. Dropping the
     * dragged rows back into the slots they occupied keeps everything else
     * exactly where it was — which is what makes unchecking an item return it to
     * its aisle rather than to the bottom of the list.
     */
    const applyDragOrder = ({ data, from, to }: { data: (AggregatedItem | Item)[]; from: number; to: number }) => {
        // A long press that ended where it started still reports a drag. Re-ranking
        // the list over it would save nothing new and would throw away whichever
        // filing is in flight, so treat it as the nothing it is.
        if (from === to) return;
        const onScreen = new Set(data.map(row => row.id));
        let next = 0;
        reRankItems(aggregatedItems.map(row => (onScreen.has(row.id) ? data[next++] ?? row : row)));
        onManualReorder?.();
    };

    const reRankItems = (data: (AggregatedItem | Item)[]) => {
        let rank = LexoRank.middle();
        const rankMap = new Map<string, string>();
        // Advance once per assigned id. genNext() is pure, so the old code gave
        // every extra source of row k the same rank that row k+1's base item
        // then got — byte-identical duplicates whose order fell back to array
        // position, which differs per device.
        const assign = (id: string) => {
            rankMap.set(id, rank.toString());
            rank = rank.genNext();
        };
        data.forEach(item => {
            if ('sourceIds' in item) {
                item.sourceIds.forEach(assign);
            } else {
                assign(item.id);
            }
        });
        setItems(prev => prev.map(originalItem => ({ ...originalItem, listOrder: rankMap.get(originalItem.id) || originalItem.listOrder })));
        markDirty();
    };

    const openQuantityEditor = (item: AggregatedItem) => {
        setSelectedItem(item);
        setIsModalVisible(true);
    };

    const closeQuantityEditor = () => {
        setIsModalVisible(false);
        setSelectedItem(null);
    };

    const handleSaveQuantity = (newQuantityStr: string) => {
        if (!selectedItem) return;
        const newQuant = newQuantityStr.trim();

        // Unchanged from the displayed total: nothing to do. (Without this,
        // saving a computed multi-unit total like "200 g + 2 tsp" would freeze
        // it as an override.)
        if (newQuant === selectedItem.totalQuantity) {
            closeQuantityEditor();
            return;
        }

        const desired = parseQuantity(newQuant);

        setItems(prev => {
            const sources = prev.filter(item => selectedItem.sourceIds.includes(item.id));
            const mealItems = sources.filter(item => !!item.mealId);
            const mainItem = sources.find(item => !item.mealId);

            const clearOverride = (item: Item): Item =>
                ({ ...item, overrideQuantity: undefined, overrideBase: undefined });

            // Empty input: drop the standalone item; meal-driven quantities remain.
            if (!newQuant) {
                return prev
                    .filter(item => item.id !== mainItem?.id)
                    .map(item => sources.some(s => s.id === item.id) ? clearOverride(item) : item);
            }

            // Snapshot of the quantities the override would be replacing
            // (excluding the main item, whose own quantity gets cleared when an
            // override is set). Used later to detect staleness.
            const overrideBase = aggregateQuantities(
                sources.filter(s => s.id !== mainItem?.id).map(s => s.quantity)
            );

            const setOverride = (): Item[] => {
                if (mainItem) {
                    return prev.map(item => item.id === mainItem.id
                        ? { ...item, quantity: undefined, overrideQuantity: newQuant, overrideBase }
                        : item);
                }
                const newItem: Item = {
                    id: uuid.v4() as string, text: selectedItem.text, checked: false, isSection: false,
                    listOrder: nextListRank(prev).toString(), overrideQuantity: newQuant, overrideBase,
                };
                return [...prev, newItem];
            };

            // How much do meal ingredients already contribute, expressed in the
            // desired unit? null = not expressible (different dimension or
            // unknown unit), in which case the input becomes an override.
            let mealContribution: number | null = desired ? 0 : null;
            if (desired && mealContribution !== null) {
                for (const item of mealItems) {
                    const parsed = parseQuantity(item.quantity);
                    if (!parsed) continue;
                    if (parsed.unit === desired.unit) {
                        mealContribution += parsed.value;
                        continue;
                    }
                    const converted = parsed.unit && desired.unit
                        ? convert(parsed.value, parsed.unit, desired.unit)
                        : null;
                    if (converted === null) { mealContribution = null; break; }
                    mealContribution += converted;
                }
            }

            if (!desired || mealContribution === null) {
                return setOverride();
            }

            const needed = desired.value - mealContribution;

            if (needed > 0) {
                const quantityToSet = formatQuantity(needed, desired.unit);
                if (mainItem) {
                    return prev.map(item => item.id === mainItem.id
                        ? { ...clearOverride(item), quantity: quantityToSet }
                        : item);
                }
                const newItem: Item = {
                    id: uuid.v4() as string, text: selectedItem.text, checked: false, isSection: false,
                    listOrder: nextListRank(prev).toString(), quantity: quantityToSet,
                };
                return [...prev, newItem];
            }

            if (needed === 0) {
                // Meals cover the desired total exactly; no standalone item needed.
                return prev
                    .filter(item => item.id !== mainItem?.id)
                    .map(item => sources.some(s => s.id === item.id) ? clearOverride(item) : item);
            }

            // Desired total is below what meals contribute. We can't shrink meal
            // ingredients from here, so honor the number as an explicit override
            // instead of silently snapping back to the meal sum.
            return setOverride();
        });

        markDirty();
        closeQuantityEditor();
    };

    /**
     * One row, for the draggable list and for the checked section alike.
     *
     * `drag` is absent for a checked row: that section is a holding pen, not a
     * part of the list you arrange, so the handle is rendered but inert to keep
     * the two sets of rows lined up with each other.
     */
    const renderRow = useCallback((item: AggregatedItem | Item, drag?: () => void, isActive?: boolean) => {
        const handle = drag ? (
            <Pressable
                onLongPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); drag(); }}
                disabled={isActive}
                style={styles.dragHandle}
                hitSlop={20}
            >
                <Text style={styles.dragIcon}>≡</Text>
            </Pressable>
        ) : (
            <View style={styles.dragHandle}><Text style={[styles.dragIcon, styles.dragIconIdle]}>≡</Text></View>
        );

        if (item.isSection) {
            const isEditing = editingId === item.id;
            // No swipe on a heading. Swiping one away would leave the rows it
            // was holding sitting under whichever aisle came before it, which
            // reads as the list having broken rather than as a deletion.
            return (
                <View key={item.id} style={styles.itemRow}>
                    {handle}
                    <TextInput
                        ref={assignRef(item.id)}
                        value={item.text}
                        style={[styles.editInput, styles.sectionText]}
                        onChangeText={text => updateSectionText(item.id, text)}
                        onFocus={() => setEditingId(item.id)}
                        onBlur={() => setEditingId('')}
                        onSubmitEditing={() => submitRow(item)}
                        onKeyPress={({ nativeEvent }) => {
                            if (nativeEvent.key === 'Backspace' && item.text === '') {
                                const currentIndex = aggregatedItems.findIndex(i => i.id === item.id);
                                const prevItem = currentIndex > 0 ? aggregatedItems[currentIndex - 1] : null;

                                setItems(prev => prev.filter(i => i.id !== item.id));
                                markDirty();

                                if (prevItem) {
                                    if ('sourceIds' in prevItem) {
                                        setEditingId((prevItem as AggregatedItem).sourceIds[0]);
                                    } else if (prevItem.isSection) {
                                        setEditingId(prevItem.id);
                                    }
                                } else {
                                    setEditingId('');
                                }
                            }
                        }}
                        returnKeyType="next"
                        blurOnSubmit={false}
                    />
                    {isEditing && (
                        <TouchableOpacity
                            // onPressIn: the input's onBlur unmounts this button
                            // before a regular onPress can fire.
                            onPressIn={() => {
                                setItems(prev => prev.filter(i => i.id !== item.id));
                                markDirty();
                            }}
                            style={styles.clearButton}
                        >
                            <Text style={styles.clearText}>✕</Text>
                        </TouchableOpacity>
                    )}
                </View>
            );
        }

        const aggItem = item as AggregatedItem;
        const baseItemId = aggItem.sourceIds[0];
        const isEditing = editingId === baseItemId;

        return (
            <SwipeToDeleteRow key={item.id} onDelete={() => deleteItem(aggItem)} enabled={!isActive}>
                <View style={styles.itemRow}>
                    {handle}
                    <TouchableOpacity style={styles.checkbox} onPress={() => toggleCheck(aggItem)}>
                        {aggItem.checked && <Text>✓</Text>}
                    </TouchableOpacity>

                    {aggItem.totalQuantity && (
                        <TouchableOpacity onPress={() => openQuantityEditor(aggItem)}>
                            <View style={[styles.quantityLabel, aggItem.checked && styles.quantityChecked]}>
                                <Text style={[styles.quantityText, aggItem.checked && styles.checked]}>{aggItem.totalQuantity}</Text>
                            </View>
                        </TouchableOpacity>
                    )}

                    <TextInput
                        ref={assignRef(baseItemId)} value={aggItem.text} style={[styles.editInput, aggItem.checked && styles.checked]}
                        onChangeText={text => updateAggregatedText(aggItem, text)} onFocus={() => setEditingId(baseItemId)}
                        onBlur={() => handleItemBlur(aggItem)} onSubmitEditing={() => submitRow(aggItem)}
                        onKeyPress={({ nativeEvent }) => { if (nativeEvent.key === 'Backspace' && aggItem.text === '') { deleteItem(aggItem, true); } }}
                        returnKeyType="next" blurOnSubmit={false}
                    />

                    {isEditing && (
                        <TouchableOpacity onPressIn={() => deleteItem(aggItem, true)} style={styles.clearButton}>
                            <Text style={styles.clearText}>✕</Text>
                        </TouchableOpacity>
                    )}
                </View>
            </SwipeToDeleteRow>
        );
    }, [items, editingId, aggregatedItems]);

    const renderItem = useCallback(
        ({ item, drag, isActive }: RenderItemParams<AggregatedItem | Item>) => renderRow(item, drag, isActive),
        [renderRow]
    );

    return (
        <View style={{ flex: 1 }}>
            { aggregatedItems.length === 0 ? (
                <View style={styles.emptyMealsContainer}>
                    <Text style={styles.emptyMealsText}>Your list is empty</Text>
                    <TouchableOpacity
                        style={styles.addMealButton}
                        onPress={() => addItemAfter()}>
                        <Text style={styles.addMealText}>+ Add Item</Text>
                    </TouchableOpacity>
                </View>
            ) : (
                <DraggableFlatList
                    ref={flatListRef}
                    data={openRows} onDragEnd={applyDragOrder}
                    keyExtractor={item => item.id} renderItem={renderItem as any}
                    keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled"
                    initialNumToRender={20} maxToRenderPerBatch={10} windowSize={10}
                    // Reordering is a vertical gesture, so say so: without this
                    // the list claims the drag as soon as a finger moves at all,
                    // in any direction, and a row can never be swiped sideways.
                    // The cost is a few pixels of travel before a held row starts
                    // following the finger.
                    activationDistance={12}
                    // A row added a moment ago has not been measured yet, and
                    // without this scrollToIndex treats that as unrecoverable
                    // and throws. Scrolling a new row into view is a nicety;
                    // losing the screen over it is not a trade worth making.
                    onScrollToIndexFailed={() => {}}
                    // `style` reaches the FlatList, which DraggableFlatList
                    // renders inside a view of its own — and that view is styled
                    // ONLY by containerStyle. Left unstyled it takes its height
                    // from its children, and a flex:1 child of a container with
                    // no height of its own resolves to nothing to fill: both
                    // measure zero and the list renders as blank white space.
                    // (Web flexbox falls back to content height here; Yoga does
                    // not, so this looks fine everywhere except on a device.)
                    containerStyle={styles.list}
                    style={styles.list}
                    contentContainerStyle={styles.listContent}
                    ListFooterComponent={
                        <>
                            {checkedRows.length > 0 && (
                                <View style={styles.checkedSection}>
                                    <Pressable
                                        style={styles.checkedHeader}
                                        onPress={() => setShowChecked(prev => !prev)}
                                        accessibilityRole="button"
                                        accessibilityState={{ expanded: showChecked }}
                                        accessibilityLabel={`Checked, ${checkedRows.length} item${checkedRows.length === 1 ? '' : 's'}`}
                                    >
                                        <Ionicons
                                            name={showChecked ? 'chevron-down' : 'chevron-forward'}
                                            size={14}
                                            color="#8e8e93"
                                        />
                                        <Text style={styles.checkedHeaderText}>Checked</Text>
                                        <Text style={styles.checkedCount}>{checkedRows.length}</Text>
                                    </Pressable>
                                    {showChecked && checkedRows.map(row => renderRow(row))}
                                </View>
                            )}
                            {/* The blank space under the last row is still the
                                list, and tapping it is how you say "another
                                one". addItemAfter hands back the empty row
                                already sitting there rather than adding a
                                second, so this survives being tapped
                                repeatedly. */}
                            <Pressable
                                style={styles.tapToAdd}
                                onPress={() => addItemAfter()}
                                accessibilityRole="button"
                                accessibilityLabel="Add item"
                            />
                        </>
                    }
                />
            )}
            <QuantityEditorModal
                isVisible={isModalVisible} item={selectedItem}
                onSave={handleSaveQuantity} onClose={closeQuantityEditor}
            />
        </View>
    );
});

GroceryListView.displayName = 'GroceryListView';

export default GroceryListView;

const styles = StyleSheet.create({
    list: { flex: 1 },
    listContent: { flexGrow: 1, paddingBottom: 80 },
    // Grows to whatever is left below the last row, with enough of a floor that
    // a full list still has somewhere to tap.
    tapToAdd: { flexGrow: 1, minHeight: 120 },
    itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, minHeight: 36, backgroundColor: '#fff' },
    dragHandle: { paddingHorizontal: 15, paddingVertical: 5 },
    dragIcon: { fontSize: 18, color: '#ccc' },
    // Kept in the layout rather than removed, so a checked row lines up with the
    // rows above it instead of shifting left once it is put away.
    dragIconIdle: { opacity: 0 },
    checkedSection: { marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#e5e5ea', backgroundColor: '#fff' },
    checkedHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 15, paddingVertical: 12 },
    checkedHeaderText: { fontSize: 13, fontWeight: '600', color: '#8e8e93', letterSpacing: 0.5, textTransform: 'uppercase' },
    checkedCount: { fontSize: 13, color: '#8e8e93' },
    checkbox: { width: 24, height: 24, marginRight: 10, borderWidth: 1, borderColor: '#999', alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
    editInput: { fontSize: 16, flex: 1, paddingVertical: 2, color: 'black' },
    checked: { textDecorationLine: 'line-through', color: '#999' },
    clearButton: { paddingHorizontal: 8, paddingVertical: 4, width: 35, alignItems: 'center' },
    clearText: { fontSize: 16, color: '#999', paddingRight: 5 },
    sectionText: { fontWeight: 'bold', fontSize: 18, color: '#333' },
    quantityLabel: { backgroundColor: '#ebebebff', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, marginRight: 6 },
    quantityChecked: { backgroundColor: '#eeeeee' },
    quantityText: { color: '#333' },
    emptyMealsContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emptyMealsText: {
        fontSize: 28,
        fontWeight: 'bold',
        color: 'grey'

    },
    addMealButton: { paddingVertical: 5 },
    addMealText: { color: primary, fontSize: 16, textAlign: 'center'  }
});
