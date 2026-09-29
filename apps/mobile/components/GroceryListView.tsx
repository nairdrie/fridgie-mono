import { BrandMark } from '@/components/ui/Brand';
// components/GroceryListView.tsx

import { useKeyboardAwareScroll } from '@/hooks/useKeyboardAwareScroll';
import { Item, Meal } from '@/types/types';
import { mealNameIndex, mealNamesForItems } from '@/utils/mealTags';
import {
    aggregateQuantities,
    convert,
    formatQuantity,
    parseQuantity,
    parseQuantityAndText,
    quantitiesEquivalent,
} from '@/utils/quantity';
import { nextListRank, safeParseRank } from '@/utils/rank';
import { reorderByAisle } from '@/utils/aisleOrder';
import { replayStep } from '@/utils/listHistory';
import { isStapleRow, stapleKey } from '@/utils/staples';
import { dropEmptiedSections } from '@fridgie/shared/listSections';
import { rowsEqual } from '@fridgie/shared/mergeList';
import { accentSoft, hairline, ink, inkFaint, inkMuted, primary, surface } from '@/utils/styles';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { LexoRank } from 'lexorank';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
    AccessibilityInfo,
    Alert,
    Keyboard,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View
} from 'react-native';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import uuid from 'react-native-uuid';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { GlassPressable, GlassSurface, useGlassPreferences } from './ui/Glass';
import FiledToast, { FiledToastInfo } from './FiledToast';
import GroceryListMenu from './GroceryListMenu';
import QuantityEditorModal from './QuantityEditorModal';
import SwipeToDeleteRow from './SwipeToDeleteRow';

type AggregatedItem = Item & {
 sourceIds: string[];
 totalQuantity: string;
 /**
  * The distinct meals this row's ingredients were required for, by name. Empty
  * for a row typed straight onto the list. Shown in grey beside the item as a
  * backlink to the meal plan — see `showMealTags`.
  */
 mealNames: string[];
};

/** Remembers the show/which-meal toggle across app launches. */
const SHOW_MEAL_TAGS_KEY = 'showMealTags';

/** Which aisles are folded away, by name, remembered across launches. */
const COLLAPSED_AISLES_KEY = 'collapsedAisles';

/**
 * What an aisle is remembered by. Not its id: the server mints a fresh id for
 * every heading each time it files (see mergeList's rowKey), so a fold keyed by
 * id would spring open again the moment anything new was added.
 */
const aisleKey = (heading: Item): string =>
    (heading.text ?? '').trim().toLowerCase() || `__aisle-${heading.id}__`;

/** Stable identity, so the split memo doesn't re-run on every render. */
const EMPTY_STAPLES: ReadonlySet<string> = new Set();

/** The floating action button hovers over the list; the last row has to clear it. */
const LIST_BOTTOM_SPACE = 190;

/**
 * What decides that two rows are the same thing and should show as one.
 *
 * A row with nothing typed into it yet is only ever itself — otherwise every
 * blank row on the list would collapse into a single checkbox.
 *
 * `?? ''` rather than `.trim()` on the raw field: a row that reached us without
 * text is a rendering bug at worst, but reading through undefined here throws
 * mid-render and takes the whole screen with it.
 */
const aggregationKey = (item: Item): string =>
    (item.text ?? '').trim().toLowerCase() || `__blank-${item.id}__`;

/** The staples card's accent: the app's warm secondary, darkened for text. */
const stapleAccent = '#B66D4E';

/** How long the "moved to" note stays up, and how long the row it names glows. */
const FILED_TOAST_MS = 4500;
const FILED_FLASH_MS = 1600;

/**
 * A soft glow over a row that has just been filed, so the eye can find where
 * it went. Keyed by the filing pass, so filing the same row again replays it.
 */
const FiledFlash = () => {
    const { reduceMotion } = useGlassPreferences();
    const opacity = useSharedValue(0);
    useEffect(() => {
        opacity.value = reduceMotion
            ? withSequence(withTiming(1, { duration: 0 }), withDelay(FILED_FLASH_MS - 400, withTiming(0, { duration: 400 })))
            : withSequence(
                withTiming(1, { duration: 220 }),
                withDelay(FILED_FLASH_MS - 720, withTiming(0, { duration: 500 })),
            );
    }, [opacity, reduceMotion]);
    const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
    return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.filedFlash, style]} />;
};

/** The group a row belonged to when the caret arrived in it. See `editPinRef`. */
interface EditPin {
    editingId: string;
    ids: ReadonlySet<string>;
}

const buildEditPin = (editingId: string, items: Item[]): EditPin | null => {
    if (!editingId) return null;
    const focused = items.find(i => i.id === editingId && !i.isSection);
    // A heading, a meal name, or a row that has not landed in `items` yet.
    // Nothing to hold together, but the pin still has to be marked as belonging
    // to this edit so it isn't rebuilt on every render for as long as it lasts.
    if (!focused) return { editingId, ids: EMPTY_STAPLES };
    const key = aggregationKey(focused);
    return {
        editingId,
        ids: new Set(items.filter(i => !i.isSection && aggregationKey(i) === key).map(i => i.id)),
    };
};

/** True when `editingId` points at this row, by either of the ids it can hold. */
const isRowBeingEdited = (row: AggregatedItem | Item, editingId: string): boolean => {
    if (!editingId) return false;
    if (row.id === editingId) return true;
    return 'sourceIds' in row && (row as AggregatedItem).sourceIds.includes(editingId);
};

/** What the screen can ask of the list, via its ref. */
export interface GroceryListHandle {
  /** Bring the row holding `itemId` into view, if it is on screen at all. */
  scrollToItemId: (itemId: string) => void;
  /** Add or focus the blank row at the end of the list. */
  addItemAtEnd: () => void;
}

// --- COMPONENT PROPS ---
interface GroceryListViewProps {
  items: Item[];
  /**
   * This week's meals, used only to name the backlink beside each item — which
   * meal put it on the list. Optional and defaulted so a list with no plan (or
   * one still loading) simply shows no tags.
   */
  meals?: Meal[];
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
  onScrollOffsetChange?: (offset: number) => void;
  /**
   * Canonical keys of the ingredients this household has been observed to
   * always have in — see packages/shared/staples.ts. Empty for a household that
   * has not rejected anything three times yet, and for one whose staples failed
   * to load, which is why an empty set has to render exactly today's list.
   */
  staples?: ReadonlySet<string>;
  /** "I do buy this" — permanently stops a key being treated as a staple. */
  onAlwaysShowStaple?: (key: string, name: string) => void;
  /**
   * Which list this is. Undo history belongs to one list: stepping back after
   * switching weeks must not replay last week's edits onto this one.
   */
  historyKey?: string;
}

const GroceryListView = forwardRef<GroceryListHandle, GroceryListViewProps>(({
    items,
    meals,
    setItems,
    editingId,
    setEditingId,
    inputRefs,
    isKeyboardVisible,
    markDirty,
    onManualReorder,
    onScrollOffsetChange,
    staples,
    onAlwaysShowStaple,
    historyKey,
}, ref) => {
    const [isModalVisible, setIsModalVisible] = useState(false);
    const [selectedItem, setSelectedItem] = useState<AggregatedItem | null>(null);
    // Checked items are put away, not shown crossed out in place, so the section
    // starts closed — opening it is asking to see what you already have.
    const [showChecked, setShowChecked] = useState(false);
    // Same reasoning as the checked section: filed away, opened on request.
    const [showStaples, setShowStaples] = useState(false);

    // Aisles the user has folded shut. Remembered across launches like the
    // meal-tag toggle: "I never need to look at Household" is a standing
    // preference, not a one-off.
    const [collapsedAisles, setCollapsedAisles] = useState<ReadonlySet<string>>(EMPTY_STAPLES);
    useEffect(() => {
        AsyncStorage.getItem(COLLAPSED_AISLES_KEY)
            .then(stored => {
                const keys = stored ? JSON.parse(stored) : null;
                if (Array.isArray(keys)) setCollapsedAisles(new Set(keys.filter(k => typeof k === 'string')));
            })
            .catch(() => {});
    }, []);
    const toggleAisle = useCallback((key: string) => {
        Haptics.selectionAsync().catch(() => {});
        setCollapsedAisles(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            AsyncStorage.setItem(COLLAPSED_AISLES_KEY, JSON.stringify([...next])).catch(() => {});
            return next;
        });
    }, []);

    // The heading being dragged, folded for the length of the drag so its
    // aisle travels with it as one block. See startAisleDrag.
    const [dragFoldedId, setDragFoldedId] = useState<string | null>(null);

    // UI-only identity for rows created by either add-at-the-end control. The
    // flag deliberately does not live on Item: drafts persist and sync exactly
    // like every other row, while this only decides where to draw them until
    // the existing filing pass gives them a section.
    const endDraftIdsRef = useRef<Set<string>>(new Set());

    // Rows the user added or renamed on THIS device that the filing pass has
    // not answered yet. Filing moves a row out of the unfiled area and up under
    // a heading that may be off screen, which reads as the row disappearing —
    // so when one of these picks up a section, the list says where it went.
    // Rows filed for a housemate, or a meal's ingredients, arrive quietly.
    //
    // Each id maps to the aisle it was in before the edit, so a rename that
    // lands back where it already was doesn't announce a move that never was.
    const awaitingFilingRef = useRef<Map<string, string | undefined>>(new Map());
    const [filedToast, setFiledToast] = useState<(FiledToastInfo & { keys: string[]; ids: string[] }) | null>(null);
    // Ids just filed, for the glow that shows where they landed. `key` replays
    // the glow on a row that is already glowing.
    const [flash, setFlash] = useState<{ ids: ReadonlySet<string>; key: number } | null>(null);
    const flashRows = (ids: Iterable<string>, delay = 0) => {
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        const start = () => {
            setFlash(prev => ({ ids: new Set(ids), key: (prev?.key ?? 0) + 1 }));
            flashTimerRef.current = setTimeout(() => setFlash(null), FILED_FLASH_MS);
        };
        if (delay > 0) flashTimerRef.current = setTimeout(start, delay);
        else start();
    };
    const filedToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => {
        if (filedToastTimerRef.current) clearTimeout(filedToastTimerRef.current);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    }, []);
    const awaitFiling = (ids: readonly string[]) => {
        const awaiting = awaitingFilingRef.current;
        for (const id of ids) {
            if (!awaiting.has(id)) awaiting.set(id, items.find(item => item.id === id)?.section);
        }
    };

    /**
     * Undo and redo, for what the user does on this screen.
     *
     * Each step keeps the list as it was before and after the change, and is
     * replayed as a merge over the list as it is now (see replayStep), so a
     * housemate's edits or a filing that landed since are not undone with it.
     *
     * Typing into one row is one step, from the first keystroke to leaving the
     * row, so undo takes back a word rather than a letter.
     */
    type HistoryStep = {
        before: Item[];
        after: Item[] | null;
        verb: string;
        subject: string;
        /** Later changes with the same key fold into this step. */
        key?: string;
        /** Stop folding once `after` has been taken. See sealTyping. */
        sealOnCapture?: boolean;
    };
    const undoStackRef = useRef<HistoryStep[]>([]);
    const redoStackRef = useRef<HistoryStep[]>([]);
    const awaitingAfterRef = useRef<HistoryStep | null>(null);
    // The stacks live in refs; this is only what makes the menu redraw.
    const [, setHistoryVersion] = useState(0);
    const bumpHistory = () => setHistoryVersion(v => v + 1);

    const recordStep = (verb: string, subject = '', key?: string) => {
        const stack = undoStackRef.current;
        const top = stack[stack.length - 1];
        if (key && top?.key === key) {
            if (subject) top.subject = subject;
            awaitingAfterRef.current = top;
        } else {
            const step: HistoryStep = { before: items, after: null, verb, subject, key };
            stack.push(step);
            if (stack.length > 50) stack.shift();
            awaitingAfterRef.current = step;
        }
        redoStackRef.current = [];
        bumpHistory();
    };
    /** The edit of a row is over; the next edit to it is a new step. */
    const sealTyping = () => {
        const top = undoStackRef.current[undoStackRef.current.length - 1];
        if (!top?.key) return;
        if (awaitingAfterRef.current === top) top.sealOnCapture = true;
        else top.key = undefined;
    };
    useEffect(() => {
        const step = awaitingAfterRef.current;
        if (!step) return;
        awaitingAfterRef.current = null;
        step.after = items;
        if (step.sealOnCapture) {
            step.key = undefined;
            step.sealOnCapture = false;
        }
    }, [items]);
    useEffect(() => {
        undoStackRef.current = [];
        redoStackRef.current = [];
        awaitingAfterRef.current = null;
        bumpHistory();
    }, [historyKey]);

    /** The step undo (or redo) would take next: the newest one that finished. */
    const nextStep = (stack: HistoryStep[]): HistoryStep | undefined => {
        for (let i = stack.length - 1; i >= 0; i--) if (stack[i].after) return stack[i];
        return undefined;
    };
    const stepLabel = (step: HistoryStep | undefined) =>
        step ? (step.subject ? `${step.verb} ${step.subject}` : step.verb) : null;

    /**
     * Moves one step from `from` to `to`, applying `toward` (before for undo,
     * after for redo) over the list as it stands. A step that no longer changes
     * anything — its row was cleaned up, or someone else already did the same —
     * is passed over rather than spending a tap on nothing.
     */
    const travel = (from: React.MutableRefObject<HistoryStep[]>, to: React.MutableRefObject<HistoryStep[]>, direction: 'undo' | 'redo') => {
        while (from.current.length > 0) {
            const step = from.current.pop()!;
            if (!step.after) continue;
            const [base, target] = direction === 'undo' ? [step.after, step.before] : [step.before, step.after];
            const merged = replayStep(base, target, items);
            step.key = undefined;
            to.current.push(step);
            if (rowsEqual(merged, items)) continue;

            Haptics.selectionAsync().catch(() => {});
            // Whatever was being typed into may be the row this takes away.
            if (editingId) {
                setEditingId('');
                Keyboard.dismiss();
            }
            awaitingAfterRef.current = null;
            setItems(merged);
            markDirty();
            // A filing answer in flight was worked out from the list before
            // this, and would put back what was just taken away.
            onManualReorder?.();
            break;
        }
        bumpHistory();
    };
    const undo = () => travel(undoStackRef, redoStackRef, 'undo');
    const redo = () => travel(redoStackRef, undoStackRef, 'redo');

    // Whether to show, beside each item, which meal put it on the list. On by
    // default so the link to the plan is there to be seen, and remembered across
    // launches once the user has an opinion either way — a deliberate display
    // preference, unlike the two collapse states above which reset each session.
    const [showMealTags, setShowMealTags] = useState(true);
    useEffect(() => {
        AsyncStorage.getItem(SHOW_MEAL_TAGS_KEY)
            .then(stored => { if (stored !== null) setShowMealTags(stored === 'true'); })
            .catch(() => {});
    }, []);
    const toggleMealTags = useCallback(() => {
        Haptics.selectionAsync().catch(() => {});
        setShowMealTags(prev => {
            const next = !prev;
            AsyncStorage.setItem(SHOW_MEAL_TAGS_KEY, String(next)).catch(() => {});
            return next;
        });
    }, []);

    // Meal id → name, rebuilt only when the plan changes. Kept out of the
    // aggregation memo below so renaming a meal is the only thing that reruns it.
    const mealNameLookup = useMemo(() => mealNameIndex(meals ?? []), [meals]);

    /**
     * The group the row under the cursor belonged to when its edit began.
     *
     * Rows combine by text, so without this, typing the "e" of "eggs" onto a
     * list that already has "egg" merges the two the instant the texts match —
     * under the cursor, before the word is finished. What that looks like from
     * the outside is the row you are typing into being deleted as you type it.
     *
     * Holding a row to the group it started in moves combining to the point the
     * edit ends — return, or tapping away — which is the first moment the text
     * is actually what the user meant it to be.
     *
     * Pinned as a whole GROUP rather than just the focused row, because renaming
     * an aggregated row rewrites every one of its sources: pinning one of them
     * would split a meal's ingredient out of its row mid-keystroke instead of
     * preventing a merge.
     *
     * Worked out during render rather than in an effect so there is never a
     * frame where the new text is on screen but the pin covering it is not.
     */
    const editPinRef = useRef<EditPin | null>(null);
    if (editPinRef.current?.editingId !== editingId) {
        editPinRef.current = buildEditPin(editingId, items);
    }

    const aggregatedItems = useMemo((): (AggregatedItem | Item)[] => {
        const itemMap = new Map<string, Item[]>();
        const sections: Item[] = [];
        const pin = editPinRef.current;

        for (const item of items) {
            if (item.isSection) {
                sections.push(item);
                continue;
            }
            // Rows in the pinned group are keyed by the edit rather than by their
            // text, which is what keeps them together and keeps everything else
            // out until the edit is over.
            const key = pin?.ids.has(item.id)
                ? `__editing-${pin.editingId}__`
                : aggregationKey(item);
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
                // The meals that contributed to this row, deduped across its
                // sources — one row can gather an ingredient from several meals.
                mealNames: mealNamesForItems(sources, mealNameLookup),
                checked: sources.every(s => s.checked),
                // `some`, not `every`: one source saying "we're out of this"
                // is enough to want the row on the list, and promoting sets it
                // on all of them anyway.
                stapleOverride: sources.some(s => s.stapleOverride),
            });
        }

        const combined = [...result, ...sections];
        combined.sort((a, b) => (a.listOrder ?? '').localeCompare(b.listOrder ?? ''));
        return combined;
        // `editingId` is what moves the pin read above, so it belongs here even
        // though the memo never names it — which is also why the rule below
        // cannot see that it is used.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items, editingId, mealNameLookup]);

    useEffect(() => {
        const stillUnfiled = new Set(items.filter(item => !item.isSection && !item.section).map(item => item.id));
        for (const id of endDraftIdsRef.current) {
            if (!stillUnfiled.has(id)) endDraftIdsRef.current.delete(id);
        }

        const awaiting = awaitingFilingRef.current;
        if (awaiting.size === 0) return;
        const byId = new Map(items.map(item => [item.id, item]));
        const filed: Item[] = [];
        for (const [id, sectionBefore] of awaiting) {
            const item = byId.get(id);
            // Deleted, or ticked off before it was filed: nothing to point at.
            if (!item || item.isSection || item.checked) awaiting.delete(id);
            else if (item.section) {
                awaiting.delete(id);
                if (item.section !== sectionBefore) filed.push(item);
            }
        }
        if (filed.length === 0) return;

        // One note per filing pass, counted in rows as the list shows them —
        // two sources that aggregate into one row are one item moved.
        const byKey = new Map<string, Item>();
        for (const item of filed) {
            const key = aggregationKey(item);
            if (!byKey.has(key)) byKey.set(key, item);
        }
        const moved = [...byKey.values()];
        const sections = new Set(moved.map(item => item.section!));
        const itemLabel = moved.length === 1 ? (moved[0].text ?? '').trim() : `${moved.length} items`;
        const section = sections.size === 1 ? moved[0].section! : null;

        setFiledToast(prev => ({
            key: (prev?.key ?? 0) + 1,
            itemLabel,
            section,
            count: moved.length,
            keys: [...byKey.keys()],
            ids: filed.map(item => item.id),
        }));
        if (filedToastTimerRef.current) clearTimeout(filedToastTimerRef.current);
        filedToastTimerRef.current = setTimeout(() => setFiledToast(null), FILED_TOAST_MS);

        flashRows(filed.map(item => item.id));

        AccessibilityInfo.announceForAccessibility(
            section ? `${itemLabel} moved to ${section}` : `${itemLabel} sorted into aisles`,
        );
    }, [items]);

    /**
     * The ✕ on the "moved to" note: the user would rather the row stayed where
     * they typed it. Every row with that text comes back together — they are
     * one row on screen — and lands at the end, in the unfiled area, marked so
     * the filing pass leaves it there.
     */
    const unfileFromToast = () => {
        if (!filedToast) return;
        const keys = new Set(filedToast.keys);
        Haptics.selectionAsync().catch(() => {});
        recordStep('Uncategorize', filedToast.count === 1 ? filedToast.itemLabel : '');
        setItems(prev => {
            let rank = nextListRank(prev);
            const updated = prev.map(item => {
                if (item.isSection || !keys.has(aggregationKey(item))) return item;
                const next: Item = { ...item, section: undefined, keepUnfiled: true, listOrder: rank.toString() };
                rank = rank.genNext();
                return next;
            });
            // Taking the only row out of an aisle leaves its heading over
            // nothing, the same as deleting it would.
            return dropEmptiedSections(prev, updated);
        });
        // A filing answer already in flight was worked out with this row in its
        // aisle and would put it straight back.
        onManualReorder?.();
        markDirty();
        if (filedToastTimerRef.current) clearTimeout(filedToastTimerRef.current);
        setFiledToast(null);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        setFlash(null);
    };

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
     *
     * A folded aisle keeps its heading on screen and hides the rows under it,
     * except one being typed into — folding must never take the keyboard away.
     * `aisleStats` is what the folded heading shows instead: how much of the
     * aisle is already in the trolley.
     */
    const { openRows, checkedRows, stapleRows, unfiledRows, aisleStats } = useMemo(() => {
        const open: (AggregatedItem | Item)[] = [];
        const checked: AggregatedItem[] = [];
        const staple: AggregatedItem[] = [];
        const unfiled: AggregatedItem[] = [];
        const stats = new Map<string, { checked: number; total: number }>();
        const stapleSet = staples ?? EMPTY_STAPLES;

        // Which heading each row sits under. A row belongs to the nearest
        // heading above it in rank order — the same rule the server files by.
        const headingOf = new Map<string, AggregatedItem | Item>();
        let heading: AggregatedItem | Item | null = null;
        for (const row of aggregatedItems) {
            if (row.isSection) heading = row;
            else if (heading) headingOf.set(row.id, heading);
        }
        const isFolded = (h: AggregatedItem | Item | undefined) =>
            !!h && (h.id === dragFoldedId || collapsedAisles.has(aisleKey(h)));
        const count = (row: AggregatedItem | Item, isChecked: boolean) => {
            const h = headingOf.get(row.id);
            if (!h) return;
            const entry = stats.get(h.id) ?? { checked: 0, total: 0 };
            entry.total++;
            if (isChecked) entry.checked++;
            stats.set(h.id, entry);
        };

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
            if (row.checked) {
                rowsBelow++;
                count(row, true);
                checked.push(row as AggregatedItem);
            } else if (
                // Checked wins over staple: a row already in the trolley has
                // been bought, and saying "you usually have this" about it
                // would be arguing with something that already happened.
                !row.stapleOverride
                // A row being edited stays put. Filing it away mid-keystroke
                // would take the keyboard with it. Both id shapes are checked
                // because the screen holds an aggregate's own id on focus but a
                // SOURCE id when arrowing backwards into one.
                && !isRowBeingEdited(row, editingId)
                && isStapleRow(row.text, stapleSet)
            ) {
                rowsBelow++;
                staple.push(row as AggregatedItem);
            } else if (
                !row.section
                && (
                    !isRowBeingEdited(row, editingId)
                    || (row as AggregatedItem).sourceIds.some(id => endDraftIdsRef.current.has(id))
                )
            ) {
                // A newly added row is deliberately outside every aisle until
                // its edit ends and the filing pass assigns one. Keeping it out
                // of `open` prevents its trailing rank from making it look like
                // it belongs to whichever heading happens to be last.
                //
                // A categorized row being renamed is the exception while its
                // input is active: editing clears its stale `section`, but it
                // should stay under the old heading rather than teleport to the
                // end on the first keystroke. Once the edit ends it joins this
                // unfiled area until it is re-filed.
                unfiled.push(row as AggregatedItem);
            } else {
                rowsBelow++;
                openBelow++;
                count(row, false);
                if (!isFolded(headingOf.get(row.id)) || isRowBeingEdited(row, editingId)) open.push(row);
            }
        }
        open.reverse();
        checked.reverse();
        staple.reverse();
        unfiled.reverse();
        return { openRows: open, checkedRows: checked, stapleRows: staple, unfiledRows: unfiled, aisleStats: stats };
    }, [aggregatedItems, editingId, staples, collapsedAisles, dragFoldedId]);

    // Whether anything on the list came from a meal at all. The show-meals
    // toggle is only offered when it would change something — a list of
    // hand-typed rows has no backlinks to reveal.
    const hasMealLinks = useMemo(
        () => aggregatedItems.some(row => !!(row as AggregatedItem).mealNames?.length),
        [aggregatedItems]
    );

    // A staple row does NOT count towards keeping its heading on screen: an
    // aisle whose only rows are things you already have is an empty aisle, and
    // showing the heading alone would put "Pantry" over nothing.

    useEffect(() => {
        if (stapleRows.length === 0) setShowStaples(false);
    }, [stapleRows.length]);

    /**
     * "We're out of this one" — puts the row back in the list for this shop.
     *
     * Deliberately per-row and per-week. The permanent version ("we don't
     * actually always have this") is the long press below, because the two are
     * different statements and conflating them would make one tap in the
     * supermarket quietly rewrite the household's staples.
     */
    const promoteStaple = (aggItem: AggregatedItem) => {
        Haptics.selectionAsync().catch(() => {});
        recordStep('Add back', (aggItem.text ?? '').trim());
        setItems(prev => prev.map(item => aggItem.sourceIds.includes(item.id)
            ? { ...item, stapleOverride: true }
            : item));
        markDirty();
    };

    const confirmAlwaysShow = (aggItem: AggregatedItem) => {
        const key = stapleKey(aggItem.text);
        if (!key || !onAlwaysShowStaple) return;
        const name = (aggItem.text ?? '').trim();
        Alert.alert(
            `Always show ${name}?`,
            'It will stop being treated as something you keep in, and will show up on every list that needs it.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Always show',
                    onPress: () => {
                        promoteStaple(aggItem);
                        onAlwaysShowStaple(key, name);
                    },
                },
            ],
        );
    };

    // Nothing left to put away: next time something is checked the section
    // should open closed again rather than remembering a session-old choice.
    useEffect(() => {
        if (checkedRows.length === 0) setShowChecked(false);
    }, [checkedRows.length]);

    // The FlatList is unmounted whenever the list is empty, so this is null as
    // often as it is set — every use goes through scrollToItemId below.
    const flatListRef = useRef<any>(null);

    // Both inputs on this screen — a row's text and a section heading — live in
    // the list, and focus bubbles, so the list hears both without either having
    // to say so.
    const keyboard = useKeyboardAwareScroll({ ref: flatListRef });

    /**
     * Which rows are on screen, as indices into `openRows`.
     *
     * Kept so that bringing a row into view can decide to do nothing, which is
     * the common case and the one that was missing: the list used to re-centre
     * on the edited row every time it was asked, and being asked on every
     * keystroke meant the list slid about underneath whatever was being typed.
     */
    const viewableRangeRef = useRef<{ first: number; last: number } | null>(null);
    // Stable identities on both: VirtualizedList refuses to have either of them
    // change after mount.
    const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: { index: number | null }[] }) => {
        let first = Infinity;
        let last = -Infinity;
        for (const token of viewableItems) {
            if (typeof token.index !== 'number') continue;
            if (token.index < first) first = token.index;
            if (token.index > last) last = token.index;
        }
        viewableRangeRef.current = last >= first ? { first, last } : null;
    }).current;
    // Nearly all of the row, so "visible" doesn't include one clipped to a
    // sliver at the edge of the screen.
    const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 90 }).current;

    /** The scroll being asked for, so a failed measure can be retried once. */
    const pendingScrollRef = useRef<{ index: number; viewPosition: number; retried: boolean } | null>(null);

    const assignRef = useCallback((id: string) => (ref: TextInput | null) => {
        inputRefs.current[id] = ref;
    }, [inputRefs]);

    const updateSectionText = (id: string, text: string) => {
        recordStep('Rename', text.trim(), `text:${id}`);
        setItems(prev => prev.map(item => (item.id === id ? { ...item, text } : item)));
        markDirty();
    };

    // Renaming an aggregated row renames every source item (including meal
    // ingredients) so the group stays together instead of splitting mid-keystroke.
    //
    // The aisle on file was decided from the old text, so it goes with it — the
    // list re-files the row once the edit settles.
    const updateAggregatedText = (aggItem: AggregatedItem, text: string) => {
        awaitFiling(aggItem.sourceIds);
        recordStep('Edit', text.trim(), `text:${aggItem.sourceIds[0]}`);
        setItems(prev => prev.map(item => aggItem.sourceIds.includes(item.id)
            ? { ...item, text, section: undefined, keepUnfiled: undefined }
            : item));
        markDirty();
    };

    const toggleCheck = (aggItem: AggregatedItem) => {
        const newCheckedState = !aggItem.checked;
        // The row is about to leave for the section at the bottom (or come back
        // from it), which is a big enough move to want confirming by touch.
        Haptics.selectionAsync().catch(() => {});
        recordStep(newCheckedState ? 'Check' : 'Uncheck', (aggItem.text ?? '').trim());
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
                endDraftIdsRef.current.add(blank.id);
                awaitFiling([blank.id]);
                // Already the row being typed into: setEditingId would be a
                // no-op, the screen's focus effect would never run, and the tap
                // would do nothing at all. Ask for the keyboard directly.
                if (editingId === blank.id) inputRefs.current[blank.id]?.focus?.();
                else setEditingId(blank.id);
                return;
            }
            const newItem: Item = { id: uuid.v4() as string, text: '', checked: false, listOrder: nextListRank(items).toString(), isSection: false };
            endDraftIdsRef.current.add(newItem.id);
            awaitFiling([newItem.id]);
            recordStep('Add', '', `text:${newItem.id}`);
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
        endDraftIdsRef.current.add(newItem.id);
        awaitFiling([newItem.id]);
        recordStep('Add', '', `text:${newItem.id}`);
        setItems(prev => [...prev, newItem]);
        setEditingId(newItem.id);
        markDirty();
    };

    useImperativeHandle(ref, () => ({
        addItemAtEnd: () => addItemAfter(),
        scrollToItemId: (itemId: string) => {
            // Rows are aggregates, not items: one row can stand for several
            // item ids, and identical texts collapse into one. Look the id up
            // through that mapping instead of assuming the two arrays line up —
            // scrollToIndex throws on an out-of-range index, and an exception
            // here blanks the screen. A checked row isn't in the list at all.
            const index = openRows.findIndex(row =>
                'sourceIds' in row ? (row as AggregatedItem).sourceIds.includes(itemId) : row.id === itemId);

            // Unfiled rows live in the footer, outside the draggable data. The
            // keyboard-aware measurement can still move one only when it is
            // genuinely obscured, without forcing the list to its end on every
            // keystroke.
            if (index < 0) {
                const isUnfiled = unfiledRows.some(row => row.sourceIds.includes(itemId));
                if (isUnfiled) keyboard.keepFocusedInputVisible();
                return;
            }

            const visible = viewableRangeRef.current;
            // Already on screen: leave the list exactly where the user put it.
            // Scrolling to a row you are looking at is movement for nothing, and
            // it is movement the user reads as the app stuttering.
            if (visible && index >= visible.first && index <= visible.last) return;

            // Otherwise move as little as it takes: to the top edge for a row
            // above the fold, to the bottom edge for one below it. Centring was
            // a much larger movement than the situation ever called for.
            const viewPosition = !visible ? 0.5 : index < visible.first ? 0 : 1;
            pendingScrollRef.current = { index, viewPosition, retried: false };
            flatListRef.current?.scrollToIndex?.({ index, animated: true, viewPosition });
        },
    }));

    /**
     * A tap on the "moved to" note: go and look. Scrolls to the aisle the row
     * was filed under and glows the row again once it has arrived.
     *
     * The heading is the target rather than the row, since "Bakery" is what the
     * note named — unless the row sits so far down a long aisle that putting
     * the heading at the top would leave the row itself off screen.
     */
    const showFiledRows = () => {
        if (!filedToast) return;
        const ids = new Set(filedToast.ids);
        if (filedToastTimerRef.current) clearTimeout(filedToastTimerRef.current);
        setFiledToast(null);
        if (scrollToFiled(ids)) return;

        // Filed into an aisle that is folded shut: open it, then go there once
        // its rows are back on screen. Through the ref, because the rows this
        // render knows about are the ones without that aisle's contents.
        let heading: AggregatedItem | Item | null = null;
        for (const row of aggregatedItems) {
            if (row.isSection) heading = row;
            else if (heading && (row as AggregatedItem).sourceIds?.some(id => ids.has(id))) {
                const key = aisleKey(heading);
                if (!collapsedAisles.has(key)) return;
                toggleAisle(key);
                setTimeout(() => scrollToFiledRef.current(ids), 120);
                return;
            }
        }
    };

    /** Scrolls to the first of `ids` on screen. False when none of them is. */
    const scrollToFiled = (ids: ReadonlySet<string>): boolean => {
        // Unchecked, still on the list, and the first of them if several moved.
        const rowIndex = openRows.findIndex(row =>
            'sourceIds' in row && (row as AggregatedItem).sourceIds.some(id => ids.has(id)));
        if (rowIndex < 0) return false;
        let headingIndex = -1;
        for (let i = rowIndex - 1; i >= 0; i--) {
            if (openRows[i].isSection) { headingIndex = i; break; }
        }
        const toHeading = headingIndex >= 0 && rowIndex - headingIndex <= 6;
        const index = toHeading ? headingIndex : rowIndex;
        const viewPosition = toHeading ? 0 : 0.3;

        Haptics.selectionAsync().catch(() => {});
        pendingScrollRef.current = { index, viewPosition, retried: false };
        flatListRef.current?.scrollToIndex?.({ index, animated: !reduceMotion, viewPosition });
        // Long enough for the scroll to land, so the glow is seen and not
        // spent while the row is still sliding into view.
        flashRows((openRows[rowIndex] as AggregatedItem).sourceIds, reduceMotion ? 0 : 350);
        return true;
    };
    const scrollToFiledRef = useRef(scrollToFiled);
    scrollToFiledRef.current = scrollToFiled;

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
        if ((aggItem.text ?? '').trim()) {
            recordStep('Delete', (aggItem.text ?? '').trim());
        } else {
            // A row that never got any text: adding it and taking it away again
            // is nothing to undo, so the step that added it goes too.
            const stack = undoStackRef.current;
            if (stack[stack.length - 1]?.key === `text:${aggItem.sourceIds[0]}`) {
                stack.pop();
                if (awaitingAfterRef.current && !stack.includes(awaitingAfterRef.current)) awaitingAfterRef.current = null;
                bumpHistory();
            }
        }
        // Taking the last row out of an aisle would leave its heading standing
        // over nothing. The render can't drop that on its own — a heading with
        // no rows under it is also what one the user has just typed looks like —
        // so it's dropped here, at the edit that emptied it, the same way
        // deleting a meal is (see dropEmptiedSections).
        const updatedItems = dropEmptiedSections(
            items,
            items.filter(item => !sourceIdsToDelete.has(item.id)),
        );
        setItems(updatedItems);
        markDirty();
        if (focusPrevious && isKeyboardVisible) {
            const survives = new Set(updatedItems.map(i => i.id));
            const currentIndex = aggregatedItems.findIndex(i => i.id === aggItem.id);
            // Nearest row above that outlived the delete. A heading emptied by
            // this delete is gone from the list now, so stepping onto it would
            // drop the caret into a row that no longer exists — skip past it to
            // whatever survived.
            let prevItem: AggregatedItem | Item | undefined;
            for (let i = currentIndex - 1; i >= 0; i--) {
                const candidate = aggregatedItems[i];
                if (candidate.isSection && !survives.has(candidate.id)) continue;
                prevItem = candidate;
                break;
            }

            if (prevItem) {
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
            recordStep('Edit', newText.trim(), `text:${baseItemId}`);
            setItems(prev =>
                prev.map(i => {
                    if (!aggItem.sourceIds.includes(i.id)) return i;
                    // Text applies to every source; a typed-in quantity only to the base.
                    const updated = { ...i, text: newText, section: undefined, keepUnfiled: undefined };
                    if (i.id === baseItemId && quantity) updated.quantity = quantity;
                    return updated;
                })
            );
            markDirty();
        }
        // Only end the edit if the caret is still HERE. Blur fires after focus
        // has already moved — tapping the space below the list focuses the new
        // row first and blurs this one second — so clearing unconditionally
        // wipes out the row that was just asked for, which is why a tap down
        // there produced a row that looked selected with nothing typing into it.
        setEditingId(prev => (aggItem.sourceIds.includes(prev) ? '' : prev));
        sealTyping();
    };

    /**
     * Puts the rows the list just handed back into the order of the whole list.
     *
     * Aisles hold together. The draggable list only ever holds the rows on
     * screen — checked items, staples, and everything in a folded aisle are
     * missing from `data` — so each heading's hidden rows are gathered back up
     * under it wherever it went. That is what makes dragging a heading move its
     * whole aisle, and what makes unchecking an item return it to its aisle
     * rather than to wherever its old rank happens to fall now.
     *
     * An item dropped under a different heading has been re-filed by hand: it
     * takes that aisle's name, so it stays there when the list files again.
     */
    const applyDragOrder = ({ data, from, to }: { data: (AggregatedItem | Item)[]; from: number; to: number }) => {
        setDragFoldedId(null);
        // A long press that ended where it started still reports a drag. Re-ranking
        // the list over it would save nothing new and would throw away whichever
        // filing is in flight, so treat it as the nothing it is.
        if (from === to) return;

        const moved = data[to];
        recordStep('Move', moved?.isSection ? `${(moved.text ?? '').trim()} aisle` : (moved?.text ?? '').trim());

        const { ordered, refiled } = reorderByAisle(aggregatedItems, data);
        reRankItems(ordered, refiled);
        onManualReorder?.();
    };

    /**
     * Long-pressing a heading's handle folds its aisle before the drag starts,
     * so the heading picks the whole aisle up with it and the rows are not left
     * behind in the list while it moves. The fold lasts only for the drag.
     *
     * The drag itself waits a moment: the list has to lay itself out without
     * the folded rows first, or it measures the drop positions against rows
     * that are no longer there.
     */
    const aisleDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startAisleDrag = (heading: Item, drag: () => void) => {
        if (collapsedAisles.has(aisleKey(heading))) {
            drag();
            return;
        }
        setDragFoldedId(heading.id);
        if (aisleDragTimerRef.current) clearTimeout(aisleDragTimerRef.current);
        aisleDragTimerRef.current = setTimeout(() => {
            aisleDragTimerRef.current = null;
            drag();
        }, 90);
    };
    // Let go before the drag got going: nothing is moving, so unfold again.
    const cancelPendingAisleDrag = () => {
        if (!aisleDragTimerRef.current) return;
        clearTimeout(aisleDragTimerRef.current);
        aisleDragTimerRef.current = null;
        setDragFoldedId(null);
    };
    useEffect(() => () => {
        if (aisleDragTimerRef.current) clearTimeout(aisleDragTimerRef.current);
    }, []);

    const reRankItems = (data: (AggregatedItem | Item)[], sections?: ReadonlyMap<string, string>) => {
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
        setItems(prev => prev.map(originalItem => {
            const section = sections?.get(originalItem.id);
            return {
                ...originalItem,
                listOrder: rankMap.get(originalItem.id) || originalItem.listOrder,
                ...(section ? { section, keepUnfiled: undefined } : {}),
            };
        }));
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
        recordStep('Change', `${(selectedItem.text ?? '').trim()} amount`);

        setItems(prev => {
            const sources = prev.filter(item => selectedItem.sourceIds.includes(item.id));
            const mealItems = sources.filter(item => !!item.mealId);
            const mainItem = sources.find(item => !item.mealId);

            const clearOverride = (item: Item): Item =>
                ({ ...item, overrideQuantity: undefined, overrideBase: undefined });

            // Drops the standalone row and clears any override off the meal
            // sources. If that row was the last thing in its aisle — the meal
            // rows are filed under other headings — the bare heading it leaves
            // behind goes too, the same way deleting the row outright does.
            const withoutStandalone = (): Item[] =>
                dropEmptiedSections(
                    prev,
                    prev
                        .filter(item => item.id !== mainItem?.id)
                        .map(item => sources.some(s => s.id === item.id) ? clearOverride(item) : item),
                );

            // Empty input: drop the standalone item; meal-driven quantities remain.
            if (!newQuant) {
                return withoutStandalone();
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
            // Converting a meal's own amount into another unit never lands back
            // on the same number — 8 oz asked for in grams is 226.8 g against a
            // 226.796 g contribution — and a typed round number ("227 g") misses
            // by more. A shortfall this far inside the total is the same amount
            // said differently, not a top-up worth shopping for.
            const negligible = Math.abs(desired.value) * 0.01;

            if (needed > negligible) {
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

            // Meals already cover the total. If what was entered is what the meals
            // aggregate to anyway, there is nothing to remember: drop the standalone
            // item and clear any override. Otherwise the same amount has been asked
            // for in a different unit ("8 oz" → "226.8 g"), which only survives as an
            // override — there is no standalone quantity left to carry it.
            if (needed >= 0) {
                if (quantitiesEquivalent(newQuant, overrideBase)) {
                    return withoutStandalone();
                }
                return setOverride();
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
                onLongPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                    if (item.isSection) startAisleDrag(item, drag);
                    else drag();
                }}
                onPressOut={item.isSection ? cancelPendingAisleDrag : undefined}
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
            const key = aisleKey(item);
            const folded = collapsedAisles.has(key) || item.id === dragFoldedId;
            const stats = aisleStats.get(item.id);
            // No swipe on a heading, and no ✕ either. Filing puts every row in
            // an aisle, so taking a heading away would only tip its rows into
            // whichever aisle came before it — the list looking broken rather
            // than anything having been deleted.
            return (
                <View key={item.id} style={[styles.itemRow, styles.sectionRow]}>
                    {handle}
                    <TextInput
                        ref={assignRef(item.id)}
                        value={item.text}
                        accessibilityLabel="Grocery category"
                        style={[styles.editInput, styles.sectionText]}
                        onChangeText={text => updateSectionText(item.id, text)}
                        onFocus={() => setEditingId(item.id)}
                        // Same reasoning as handleItemBlur: blur lands after the
                        // next row has taken focus, so this must not speak for it.
                        onBlur={() => {
                            setEditingId(prev => (prev === item.id ? '' : prev));
                            sealTyping();
                        }}
                        onSubmitEditing={() => submitRow(item)}
                        onKeyPress={({ nativeEvent }) => {
                            if (nativeEvent.key === 'Backspace' && item.text === '') {
                                recordStep('Remove heading');
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
                    <Pressable
                        onPress={() => toggleAisle(key)}
                        hitSlop={12}
                        style={({ pressed }) => [styles.aisleToggle, pressed && styles.aisleTogglePressed]}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: !folded }}
                        accessibilityLabel={folded && stats
                            ? `${item.text || 'Aisle'}, ${stats.checked} of ${stats.total} checked. Show items`
                            : `${folded ? 'Show' : 'Hide'} ${item.text || 'aisle'} items`}
                    >
                        {folded && stats && (
                            <Text style={[styles.aisleCount, stats.checked > 0 && styles.aisleCountProgress]}>
                                {stats.checked}/{stats.total}
                            </Text>
                        )}
                        <Ionicons name={folded ? 'chevron-forward' : 'chevron-down'} size={15} color={inkMuted} />
                    </Pressable>
                </View>
            );
        }

        const aggItem = item as AggregatedItem;
        const baseItemId = aggItem.sourceIds[0];
        const isEditing = editingId === baseItemId;

        return (
            <View key={item.id} style={styles.swipeRowFrame}>
            <SwipeToDeleteRow onDelete={() => deleteItem(aggItem)} enabled={!isActive}>
                <View style={styles.itemRow}>
                    {handle}
                    <GlassPressable haptic={false} hitSlop={10} style={[styles.checkbox, aggItem.checked && styles.checkboxChecked]} onPress={() => toggleCheck(aggItem)} accessibilityRole="checkbox" accessibilityState={{ checked: aggItem.checked }} accessibilityLabel={`Mark ${aggItem.text || "item"} ${aggItem.checked ? "not bought" : "bought"}`}>
                        {aggItem.checked && <Ionicons name="checkmark" size={15} color="#fff" />}
                    </GlassPressable>

                    {aggItem.totalQuantity && (
                        <GlassPressable onPress={() => openQuantityEditor(aggItem)} accessibilityLabel={`Edit quantity for ${aggItem.text || "item"}`}>
                            <View style={[styles.quantityLabel, aggItem.checked && styles.quantityChecked]}>
                                <Text style={[styles.quantityText, aggItem.checked && styles.checked]}>{aggItem.totalQuantity}</Text>
                            </View>
                        </GlassPressable>
                    )}

                    {/* Text and its backlink stack in a column so the meal
                        name sits directly under the item rather than fighting
                        the input for the row's width. The input carries the
                        column's full width without `flex`, so tapping anywhere
                        along the row still lands in it. */}
                    <View style={styles.itemBody}>
                        <TextInput
                            accessibilityLabel="Grocery item" ref={assignRef(baseItemId)} value={aggItem.text} style={[styles.itemInput, aggItem.checked && styles.checked]}
                            onChangeText={text => updateAggregatedText(aggItem, text)} onFocus={() => {
                                // A draft restored from sync has no in-memory
                                // marker yet. Capture it before typing so the
                                // first character cannot move it under the last
                                // aisle heading.
                                if (!aggItem.section) aggItem.sourceIds.forEach(id => endDraftIdsRef.current.add(id));
                                setEditingId(baseItemId);
                            }}
                            onBlur={() => handleItemBlur(aggItem)} onSubmitEditing={() => submitRow(aggItem)}
                            onKeyPress={({ nativeEvent }) => { if (nativeEvent.key === 'Backspace' && aggItem.text === '') { deleteItem(aggItem, true); } }}
                            returnKeyType="next" blurOnSubmit={false}
                        />
                        {showMealTags && aggItem.mealNames.length > 0 && (
                            <View style={styles.mealTagRow}>
                                <Ionicons name="restaurant-outline" size={11} color={inkFaint} style={styles.mealTagIcon} />
                                <Text style={styles.mealTagText} numberOfLines={1}>
                                    {aggItem.mealNames.join(', ')}
                                </Text>
                            </View>
                        )}
                    </View>

                    {isEditing && (
                        <GlassPressable onPressIn={() => deleteItem(aggItem, true)} onPress={() => deleteItem(aggItem, true)} style={styles.clearButton} accessibilityLabel={`Delete ${aggItem.text || "item"}`}>
                            <Text style={styles.clearText}>✕</Text>
                        </GlassPressable>
                    )}
                </View>
            </SwipeToDeleteRow>
            {flash && aggItem.sourceIds.some(id => flash.ids.has(id)) && <FiledFlash key={flash.key} />}
            </View>
        );
        // `showMealTags` is read inside a row, so it belongs here: without it the
        // memoized row keeps a stale closure and the tags don't appear or vanish
        // until something else (an edit, a check) forces the list to redraw.
    }, [items, editingId, aggregatedItems, showMealTags, flash, collapsedAisles, dragFoldedId, aisleStats]);

    const renderItem = useCallback(
        ({ item, drag, isActive }: RenderItemParams<AggregatedItem | Item>) => renderRow(item, drag, isActive),
        [renderRow]
    );

    // Aisles on the list, by the name their fold is remembered under.
    const aisleKeys = useMemo(
        () => [...new Set(aggregatedItems.filter(row => row.isSection).map(row => aisleKey(row)))],
        [aggregatedItems],
    );
    const setAllAislesFolded = (fold: boolean) => {
        Haptics.selectionAsync().catch(() => {});
        setCollapsedAisles(prev => {
            const next = new Set(prev);
            for (const key of aisleKeys) {
                if (fold) next.add(key);
                else next.delete(key);
            }
            AsyncStorage.setItem(COLLAPSED_AISLES_KEY, JSON.stringify([...next])).catch(() => {});
            return next;
        });
    };

    /**
     * "3/10 checked" at the top: opens the checked section and brings it up to
     * the top of the screen.
     *
     * Measured rather than estimated — the section sits below every aisle,
     * however tall they are — and after it has opened, so the list is long
     * enough to put it at the top. Clamped to the end of the list: scrolling
     * past it on iOS leaves a gap that does not bounce back.
     */
    const checkedSectionRef = useRef<View>(null);
    const contentHeightRef = useRef(0);
    const viewportHeightRef = useRef(0);
    const showCheckedSection = () => {
        Haptics.selectionAsync().catch(() => {});
        setShowChecked(true);
        setTimeout(() => {
            const list = flatListRef.current;
            const scroller = list?.getNativeScrollRef?.();
            const content = scroller?.getInnerViewRef?.() ?? scroller?.getInnerViewNode?.();
            const animated = !reduceMotion;
            const toEnd = () => list?.scrollToEnd?.({ animated });
            if (!content || !checkedSectionRef.current) return toEnd();
            checkedSectionRef.current.measureLayout(
                content,
                (_x, y) => {
                    const max = Math.max(0, contentHeightRef.current - viewportHeightRef.current);
                    list?.scrollToOffset?.({ offset: Math.min(Math.max(0, y - 8), max), animated });
                },
                toEnd,
            );
        }, 80);
    };

    const toBuyCount = [...openRows, ...unfiledRows].filter(item => !item.isSection && item.text?.trim()).length;
    const boughtCount = checkedRows.filter(item => item.text?.trim()).length;
    const shoppingCount = toBuyCount + boughtCount;
    const { reduceMotion } = useGlassPreferences();
    const shoppingProgress = useSharedValue(0);
    useEffect(() => {
        const progress = shoppingCount > 0 ? boughtCount / shoppingCount : 0;
        shoppingProgress.value = reduceMotion ? progress : withSpring(progress, { damping: 22, stiffness: 150, reduceMotion: ReduceMotion.System });
    }, [boughtCount, shoppingCount, reduceMotion, shoppingProgress]);
    const progressStyle = useAnimatedStyle(() => ({ width: `${shoppingProgress.value * 100}%` as `${number}%` }));
    const trackKeyboardOffset = keyboard.draggableProps.onScrollOffsetChange;
    const handleScrollOffsetChange = useCallback((offset: number) => {
        trackKeyboardOffset(offset);
        onScrollOffsetChange?.(offset);
    }, [trackKeyboardOffset, onScrollOffsetChange]);

    return (
        <View style={{ flex: 1 }} onLayout={event => { viewportHeightRef.current = event.nativeEvent.layout.height; }}>
            { aggregatedItems.length === 0 ? (
                <ScrollView contentContainerStyle={styles.emptyMealsContainer} showsVerticalScrollIndicator={false} onScroll={event => handleScrollOffsetChange(event.nativeEvent.contentOffset.y)} scrollEventThrottle={16}>
                    <View style={styles.emptyIllustration}>
                        <View style={styles.emptyHalo} />
                        <GlassSurface style={styles.emptyIcon} intensity={45}>
                            <Ionicons name="basket-outline" size={44} color={primary} />
                        </GlassSurface>
                        <View style={styles.emptyLeaf}><BrandMark size={20} color={primary} /></View>
                    </View>
                    <Text style={styles.emptyMealsText}>Your shopping list</Text>
                    <Text style={styles.emptySubtext}>Add an item, or plan a meal to gather its ingredients here.</Text>
                    <GlassPressable
                        style={styles.addMealButton}
                        onPress={() => addItemAfter()}>
                        <Ionicons name="add" size={20} color="#fff" />
                        <Text style={styles.addMealText}>Add your first item</Text>
                    </GlassPressable>
                </ScrollView>
            ) : (
                <DraggableFlatList
                    ref={flatListRef}
                    // onScroll is spoken for here — this list drives its own
                    // drag-to-autoscroll with it — so it reports where it is
                    // scrolled to through onScrollOffsetChange instead.
                    {...keyboard.draggableProps}
                    onScrollOffsetChange={handleScrollOffsetChange}
                    data={openRows} onDragEnd={applyDragOrder}
                    keyExtractor={item => item.id} renderItem={renderItem as any}
                    // Progress counts the visible shopping rows after aggregation,
                    // and leaves pantry staples out until they are added back.
                    ListHeaderComponent={
                        <View>
                            <View style={styles.listHeader}>
                                <View style={styles.progressSummary}>
                                    <View style={styles.progressLabels}>
                                        <Text style={styles.progressCount}>{toBuyCount} to buy</Text>
                                        {boughtCount > 0 ? (
                                            // Where the checked items went: they
                                            // leave their aisles, and this is
                                            // the way to them.
                                            <Pressable
                                                onPress={showCheckedSection}
                                                hitSlop={10}
                                                style={({ pressed }) => [styles.progressCaptionLink, pressed && styles.pressedFaint]}
                                                accessibilityRole="button"
                                                accessibilityLabel={`${boughtCount} of ${shoppingCount} checked`}
                                                accessibilityHint="Shows the checked items"
                                            >
                                                <Text style={[styles.progressCaption, styles.progressCaptionActive]}>{boughtCount}/{shoppingCount} checked</Text>
                                                <Ionicons name="chevron-down" size={11} color={primary} />
                                            </Pressable>
                                        ) : (
                                            <Text style={styles.progressCaption}>{boughtCount}/{shoppingCount} checked</Text>
                                        )}
                                    </View>
                                    <View style={styles.progressTrack} accessibilityRole="progressbar" accessibilityLabel="Shopping progress" accessibilityValue={{ min: 0, max: Math.max(1, shoppingCount), now: boughtCount }} aria-valuemin={0} aria-valuemax={Math.max(1, shoppingCount)} aria-valuenow={boughtCount}>
                                        <Animated.View style={[styles.progressFill, progressStyle]} />
                                    </View>
                                </View>
                                <GroceryListMenu
                                    undoLabel={stepLabel(nextStep(undoStackRef.current))}
                                    redoLabel={stepLabel(nextStep(redoStackRef.current))}
                                    onUndo={undo}
                                    onRedo={redo}
                                    mealTags={hasMealLinks ? { shown: showMealTags, onToggle: toggleMealTags } : undefined}
                                    aisles={aisleKeys.length > 0 ? {
                                        allFolded: aisleKeys.every(key => collapsedAisles.has(key)),
                                        onFoldAll: () => setAllAislesFolded(true),
                                        onUnfoldAll: () => setAllAislesFolded(false),
                                    } : undefined}
                                />
                            </View>
                            {/* At the top, before anything else on the
                                list: it is the question to answer before
                                setting off ("are we actually out of any of
                                these?"), not something to scroll past the
                                whole shop to find. Collapsed, it costs one
                                line. */}
                            {stapleRows.length > 0 && (
                                <View style={styles.stapleSection}>
                                    {/* Tinted and titled like a card of
                                        its own, with what is in it spelled
                                        out while collapsed: these are easy to
                                        scroll past, and skipping them is how
                                        you get home without the rice. */}
                                    <Pressable
                                        style={({ pressed }) => [styles.stapleHeader, pressed && styles.stapleHeaderPressed]}
                                        onPress={() => setShowStaples(prev => !prev)}
                                        accessibilityRole="button"
                                        accessibilityState={{ expanded: showStaples }}
                                        accessibilityLabel={`You usually have these, ${stapleRows.length} item${stapleRows.length === 1 ? '' : 's'}: ${stapleRows.map(row => row.text).join(', ')}`}
                                        accessibilityHint={showStaples ? 'Hides them' : "Shows them, so you can add back anything you're out of"}
                                    >
                                        <View style={styles.stapleIcon}>
                                            <Ionicons name="home" size={15} color={stapleAccent} />
                                        </View>
                                        <View style={styles.stapleHeaderBody}>
                                            <View style={styles.stapleTitleRow}>
                                                <Text style={styles.stapleTitle}>You usually have these</Text>
                                                <Text style={styles.stapleCount}>{stapleRows.length}</Text>
                                            </View>
                                            {!showStaples && (
                                                <Text style={styles.staplePreview} numberOfLines={1}>
                                                    {stapleRows.slice(0, 4).map(row => row.text).join(', ')}
                                                    {stapleRows.length > 4 ? ` +${stapleRows.length - 4}` : ''}
                                                    {' · Out of any?'}
                                                </Text>
                                            )}
                                        </View>
                                        <Ionicons
                                            name={showStaples ? 'chevron-up' : 'chevron-down'}
                                            size={16}
                                            color={stapleAccent}
                                        />
                                    </Pressable>
                                    {showStaples && (
                                        <>
                                            {/* Says what a tap does before the
                                                user has to guess. The rows are
                                                not swipeable or draggable in
                                                here — they are a question, not
                                                a list. */}
                                            <Text style={styles.stapleHint}>
                                                Tap one to add it back for this shop. Hold to stop treating it
                                                as something you keep in.
                                            </Text>
                                            {stapleRows.map(row => (
                                                <Pressable
                                                    key={row.id}
                                                    style={styles.stapleRow}
                                                    onPress={() => promoteStaple(row)}
                                                    onLongPress={() => confirmAlwaysShow(row)}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={`Add ${row.text} back to the list`}
                                                >
                                                    <Ionicons name="add-circle-outline" size={21} color={stapleAccent} />
                                                    <Text style={styles.stapleText} numberOfLines={1}>{row.text}</Text>
                                                    {!!row.totalQuantity && (
                                                        <Text style={styles.stapleQuantity}>{row.totalQuantity}</Text>
                                                    )}
                                                </Pressable>
                                            ))}
                                        </>
                                    )}
                                </View>
                            )}
                        </View>
                    }
                    keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled"
                    initialNumToRender={20} maxToRenderPerBatch={10} windowSize={10}
                    // Reordering is a vertical gesture, so say so: without this
                    // the list claims the drag as soon as a finger moves at all,
                    // in any direction, and a row can never be swiped sideways.
                    // The cost is a few pixels of travel before a held row starts
                    // following the finger.
                    activationDistance={12}
                    onViewableItemsChanged={onViewableItemsChanged}
                    viewabilityConfig={viewabilityConfig}
                    // A row added a moment ago has not been measured yet, and
                    // without this scrollToIndex treats that as unrecoverable
                    // and throws. Scrolling a new row into view is a nicety;
                    // losing the screen over it is not a trade worth making.
                    //
                    // Swallowing it outright was too far the other way, though:
                    // the one time this fires is the one time the scroll was
                    // most wanted — a row that was added a frame ago, which is
                    // exactly what a tap on the space below the list produces.
                    // So get close enough on estimated heights that the row
                    // renders, then ask again. Once: a nicety is not worth a
                    // loop of scroll attempts.
                    onScrollToIndexFailed={info => {
                        const pending = pendingScrollRef.current;
                        if (!pending || pending.retried || pending.index !== info.index) return;
                        pending.retried = true;
                        if (info.averageItemLength > 0) {
                            flatListRef.current?.scrollToOffset?.({
                                offset: info.averageItemLength * info.index,
                                animated: true,
                            });
                        }
                        setTimeout(() => {
                            // Something else has asked for a scroll since; that
                            // one is the current answer, not this.
                            if (pendingScrollRef.current !== pending) return;
                            flatListRef.current?.scrollToIndex?.({
                                index: info.index,
                                animated: true,
                                viewPosition: pending.viewPosition,
                            });
                        }, 150);
                    }}
                    // `style` reaches the FlatList, which DraggableFlatList
                    // renders inside a view of its own — and that view is styled
                    // ONLY by containerStyle. Left unstyled it takes its height
                    // from its children, and a flex:1 child of a container with
                    // no height of its own resolves to nothing to fill: both
                    // measure zero and the list renders as blank white space.
                    // (Web flexbox falls back to content height here; Yoga does
                    // not, so this looks fine everywhere except on a device.)
                    onContentSizeChange={(_w: number, h: number) => { contentHeightRef.current = h; }}
                    containerStyle={styles.list}
                    style={styles.list}
                    // The bottom row of a list has nothing below it to scroll up
                    // in its place, so without room made for the keyboard it can
                    // never rise above one. See useKeyboardAwareScroll.
                    contentContainerStyle={[styles.listContent, { paddingBottom: (isKeyboardVisible ? 28 : LIST_BOTTOM_SPACE) + keyboard.keyboardSpace }]}
                    ListFooterComponent={
                        <>
                            {checkedRows.length > 0 && (
                                <View ref={checkedSectionRef} collapsable={false} style={styles.checkedSection}>
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
                            {unfiledRows.length > 0 && (
                                <View style={styles.unfiledItems}>
                                    {unfiledRows.map(row => renderRow(row))}
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
                            >
                                <View style={styles.addAnotherItem}>
                                    <Ionicons name="add-circle-outline" size={21} color={primary} />
                                    <Text style={styles.addAnotherText}>Add another item</Text>
                                </View>
                            </Pressable>
                        </>
                    }
                />
            )}
            <FiledToast toast={filedToast} onShow={showFiledRows} onUnfile={unfileFromToast} />
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
    listContent: { flexGrow: 1, paddingHorizontal: 20, paddingBottom: LIST_BOTTOM_SPACE },
    // Grows to whatever is left below the last row, with enough of a floor that
    // a full list still has somewhere to tap.
    tapToAdd: { flexGrow: 1, minHeight: 120 },
    itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingRight: 12, minHeight: 55, backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: 17, borderWidth: 1, borderColor: 'rgba(255,255,255,0.8)' },
    swipeRowFrame: { borderRadius: 17, overflow: 'hidden', marginBottom: 3 },
    filedFlash: { borderRadius: 17, borderWidth: 1.5, borderColor: 'rgba(35, 120, 94, 0.35)', backgroundColor: 'rgba(35, 120, 94, 0.10)' },
    sectionRow: { backgroundColor: 'transparent', borderColor: 'transparent', paddingTop: 18, paddingBottom: 8, minHeight: 48, marginBottom: 0 },
    checkboxChecked: { backgroundColor: primary, borderColor: primary },
    dragHandle: { paddingLeft: 10, paddingRight: 9, paddingVertical: 5 },
    dragIcon: { fontSize: 16, color: '#C8D2C9' },
    // Kept in the layout rather than removed, so a checked row lines up with the
    // rows above it instead of shifting left once it is put away.
    dragIconIdle: { opacity: 0 },
    // Warm, where the rest of the list is green and white: set apart enough to
    // be noticed on the way past, without shouting like a warning would.
    stapleSection: { marginTop: 4, marginBottom: 10, borderRadius: 17, backgroundColor: '#FBEFE8', borderWidth: 1, borderColor: 'rgba(233,162,139,0.4)', overflow: 'hidden' },
    stapleHeader: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingLeft: 12, paddingRight: 14, paddingVertical: 11 },
    stapleHeaderPressed: { backgroundColor: 'rgba(233,162,139,0.12)' },
    stapleIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F4DDD0' },
    stapleHeaderBody: { flex: 1 },
    stapleTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    stapleTitle: { fontSize: 14, fontWeight: '600', color: ink },
    stapleCount: { fontSize: 11, fontWeight: '600', color: stapleAccent, backgroundColor: '#F4DDD0', borderRadius: 9, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
    staplePreview: { fontSize: 12, color: inkMuted, marginTop: 2 },
    checkedSection: { marginTop: 17, paddingTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hairline },
    // A quiet boundary is enough to show that a draft is not part of the final
    // named aisle; it does not need a user-facing "Uncategorized" category.
    unfiledItems: { marginTop: 17, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hairline },
    checkedHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 15, paddingVertical: 12 },
    stapleHint: { fontSize: 12, color: inkMuted, lineHeight: 17, paddingHorizontal: 15, paddingBottom: 10 },
    stapleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 15, paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(233,162,139,0.45)' },
    stapleText: { flex: 1, fontSize: 16, color: ink },
    stapleQuantity: { fontSize: 13, color: inkFaint },
    checkedHeaderText: { fontSize: 13, fontWeight: '600', color: inkMuted },
    checkedCount: { fontSize: 11, color: primary, backgroundColor: accentSoft, borderRadius: 9, paddingHorizontal: 6, paddingVertical: 2 },
    checkbox: { width: 24, height: 24, marginRight: 12, borderWidth: 1.5, borderColor: '#C5D2C8', alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
    editInput: { fontSize: 16, flex: 1, paddingVertical: 2, color: ink },
    // The item row's own input. No `flex` because its column parent (itemBody)
    // owns the width; a column child with flex:1 would instead stretch tall.
    itemBody: { flex: 1, justifyContent: 'center' },
    itemInput: { fontSize: 16, paddingVertical: 2, color: ink },
    // The backlink line under an item: which meal(s) put it on the list.
    mealTagRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
    mealTagIcon: { marginTop: 0.5 },
    mealTagText: { flex: 1, fontSize: 12, color: inkFaint },
    checked: { textDecorationLine: 'line-through', color: inkFaint },
    clearButton: { paddingHorizontal: 8, paddingVertical: 4, width: 35, alignItems: 'center' },
    clearText: { fontSize: 16, color: inkFaint, paddingRight: 5 },
    // The fold control on an aisle heading, with the aisle's progress beside
    // the chevron while it is folded.
    aisleToggle: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, marginLeft: 4 },
    aisleTogglePressed: { backgroundColor: 'rgba(23,63,53,0.06)' },
    aisleCount: { fontSize: 12, fontWeight: '600', color: inkMuted, backgroundColor: 'rgba(23,63,53,0.06)', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },
    aisleCountProgress: { color: primary, backgroundColor: accentSoft },
    sectionText: { fontWeight: '700', fontSize: 12, color: inkMuted, letterSpacing: 1.3, textTransform: 'uppercase' },
    quantityLabel: { backgroundColor: accentSoft, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, marginRight: 8 },
    quantityChecked: { backgroundColor: surface },
    quantityText: { color: primary, fontSize: 12, fontWeight: '600' },
    listHeader: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingTop: 8, paddingBottom: 9 },
    progressSummary: { flex: 1 },
    progressLabels: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 7 },
    progressCount: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: ink },
    progressCaptionLink: { flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 6 },
    progressCaptionActive: { color: primary, fontWeight: '600' },
    pressedFaint: { opacity: 0.55 },
    progressCaption: { color: inkMuted, fontSize: 11, lineHeight: 17 },
    progressTrack: { height: 3, backgroundColor: 'rgba(23,63,53,0.07)', borderRadius: 2, marginTop: 6, overflow: 'hidden' },
    progressFill: { height: 3, backgroundColor: primary, borderRadius: 2 },
    addAnotherItem: { flexDirection: 'row', gap: 9, alignItems: 'center', paddingHorizontal: 29, paddingTop: 22 },
    addAnotherText: { color: primary, fontSize: 14, fontWeight: '600' },
    emptyMealsContainer: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 30, paddingBottom: 155, paddingTop: 25 },
    emptyIllustration: { width: 170, height: 145, alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
    emptyHalo: { position: 'absolute', width: 140, height: 140, borderRadius: 70, backgroundColor: '#DCEDE2' },
    emptyIcon: { width: 102, height: 102, borderRadius: 33, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-8deg' }] },
    emptyLeaf: { position: 'absolute', right: 0, bottom: 9, width: 44, height: 44, borderRadius: 22, backgroundColor: '#E7EEDC', borderWidth: 2, borderColor: '#F5F5EF', alignItems: 'center', justifyContent: 'center' },
    emptyMealsText: { fontSize: 28, lineHeight: 34, fontWeight: '700', color: ink, letterSpacing: -1.2, textAlign: 'center', marginTop: 11 },
    emptySubtext: { fontSize: 15, lineHeight: 23, color: inkMuted, textAlign: 'center', marginTop: 13, maxWidth: 310 },
    addMealButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 25, paddingVertical: 16, paddingHorizontal: 26, borderRadius: 28, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)', backgroundColor: primary },
    addMealText: { color: '#fff', fontSize: 16, fontWeight: '600' }
});
