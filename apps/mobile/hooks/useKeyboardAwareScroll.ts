// hooks/useKeyboardAwareScroll.ts
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Keyboard,
    KeyboardEvent,
    NativeScrollEvent,
    NativeSyntheticEvent,
    TextInput,
    TextInputFocusEventData,
} from 'react-native';

/**
 * A text input's focus travels up the tree as a BUBBLING event, so a scroll
 * container can hear every input inside it without any of them opting in. React
 * Native's own types only ever declare the handler on the input itself, so say
 * it here once — otherwise every container would need a cast.
 */
declare module 'react-native' {
    interface ViewProps {
        /** Fires when any TextInput below this view takes focus. */
        onFocusCapture?: (event: NativeSyntheticEvent<TextInputFocusEventData>) => void;
    }
}

/** Clear space left between the focused input and whatever is under it. */
const DEFAULT_GAP = 24;

/** Small enough to be rounding rather than a row hidden behind the keyboard. */
const SLOP = 1;

type Measurable = {
    measureInWindow?: (
        callback: (x: number, y: number, width: number, height: number) => void,
    ) => void;
};

/** Whatever the ref was attached to: FlatList, ScrollView, DraggableFlatList. */
type Scrollable = Measurable & {
    scrollToOffset?: (params: { offset: number; animated?: boolean }) => void;
    scrollTo?: (params: { y?: number; animated?: boolean }) => void;
    getNativeScrollRef?: () => Measurable | null;
};

export interface KeyboardAwareScroll {
    /** Attach to the scroll container. */
    scrollRef: React.MutableRefObject<any>;
    /** Add to the container's `contentContainerStyle` paddingBottom. */
    keyboardSpace: number;
    /** Spread onto a FlatList or ScrollView. */
    scrollProps: {
        onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
        scrollEventThrottle: number;
        onFocusCapture: () => void;
    };
    /** Spread onto a DraggableFlatList, which keeps `onScroll` for itself. */
    draggableProps: {
        onScrollOffsetChange: (offset: number) => void;
        onFocusCapture: () => void;
    };
    /** Put the focused input back in view. A no-op when it already is. */
    keepFocusedInputVisible: () => void;
}

/**
 * Keeps the focused text input clear of the keyboard, in any scroll container.
 *
 * Two things have to be true for a tapped input to end up somewhere you can see
 * it, and React Native does neither on its own:
 *
 *  1. **There has to be somewhere to scroll to.** Scrolling stops at the end of
 *     the content, so a row at the bottom of a list cannot be lifted above the
 *     keyboard however hard you drag — which is exactly why the last meal in the
 *     plan stayed underneath it. `keyboardSpace` is the padding that gives the
 *     content that extra room while the keyboard is up. It is worked out from
 *     where the container actually ends on screen, so one already lifted clear
 *     (by a KeyboardAvoidingView, or by being a sheet above the keyboard) asks
 *     for almost nothing, and one running the full height of the screen asks for
 *     a keyboard's worth.
 *
 *  2. **Something has to do the scrolling.** Nothing in React Native scrolls a
 *     focused input into view; that is what the keyboard listeners and
 *     `onFocusCapture` below are for.
 *
 * Everything is measured in window coordinates, so it does not matter how deeply
 * the input is nested — a meal plan's ingredient row lives inside a list inside
 * a card inside the list this is attached to, and still lands in the right place.
 *
 * ```tsx
 * const keyboard = useKeyboardAwareScroll();
 * <FlatList
 *   ref={keyboard.scrollRef}
 *   {...keyboard.scrollProps}
 *   contentContainerStyle={[styles.content, { paddingBottom: 80 + keyboard.keyboardSpace }]}
 * />
 * ```
 */
export function useKeyboardAwareScroll(options: {
    /** Clear space to leave under the focused input. */
    gap?: number;
    /** An existing ref to the scroll container, if the caller already has one. */
    ref?: React.MutableRefObject<any>;
    /**
     * Whether this container is the one being typed into. Keyboard events are
     * global, so a screen that owns two scrollers — a page and the modal over
     * it — has to say which of them the caller is looking at, or the one behind
     * scrolls itself to an input it does not contain.
     */
    enabled?: boolean;
} = {}): KeyboardAwareScroll {
    const { gap = DEFAULT_GAP, ref, enabled = true } = options;

    const ownRef = useRef<any>(null);
    const scrollRef = ref ?? ownRef;

    /** Where the container is scrolled to, fed by onScroll below. */
    const offsetRef = useRef(0);
    /** Top edge of the keyboard in window coordinates; null while it is down. */
    const keyboardTopRef = useRef<number | null>(null);
    /** The container's own edges, in the same coordinates. */
    const boundsRef = useRef<{ top: number; bottom: number } | null>(null);
    /** Measuring is asynchronous, and the answer can arrive after the unmount. */
    const mountedRef = useRef(true);

    const [keyboardSpace, setKeyboardSpace] = useState(0);

    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    const scrollToOffset = useCallback((offset: number) => {
        const scrollable: Scrollable | null = scrollRef.current;
        const target = Math.max(0, offset);
        if (typeof scrollable?.scrollToOffset === 'function') {
            scrollable.scrollToOffset({ offset: target, animated: true });
        } else if (typeof scrollable?.scrollTo === 'function') {
            scrollable.scrollTo({ y: target, animated: true });
        }
    }, [scrollRef]);

    const measureContainer = useCallback(() => {
        const scrollable: Scrollable | null = scrollRef.current;
        // FlatList and ScrollView are composite components; the thing with a
        // frame on screen is the native view underneath them.
        const view = scrollable?.getNativeScrollRef?.() ?? scrollable;
        if (typeof view?.measureInWindow !== 'function') return;

        view.measureInWindow((_x, y, _width, height) => {
            if (!mountedRef.current || !(height > 0)) return;
            boundsRef.current = { top: y, bottom: y + height };

            const keyboardTop = keyboardTopRef.current;
            if (keyboardTop == null) return;
            // Only the part of the keyboard that actually covers this container
            // has to be made up for. Add the gap on top so the focused row can
            // end up above the keyboard's edge rather than flush against it.
            setKeyboardSpace(Math.max(0, y + height - keyboardTop) + gap);
        });
    }, [gap, scrollRef]);

    const keepFocusedInputVisible = useCallback(() => {
        const keyboardTop = keyboardTopRef.current;
        if (keyboardTop == null) return; // nothing is covering anything yet

        const input: Measurable | null = TextInput.State.currentlyFocusedInput();
        if (typeof input?.measureInWindow !== 'function') return;

        const bounds = boundsRef.current;
        // The keyboard is not always what cuts the container short: a sheet or an
        // avoider can end above it, and scrolling to the keyboard's edge would
        // then park the input just off the bottom of the list instead.
        const visibleBottom = Math.min(bounds?.bottom ?? keyboardTop, keyboardTop);
        const visibleTop = bounds?.top ?? 0;

        input.measureInWindow((_x, y, _width, height) => {
            if (!mountedRef.current || !(height > 0)) return;

            const hiddenBelow = y + height + gap - visibleBottom;
            if (hiddenBelow > SLOP) {
                scrollToOffset(offsetRef.current + hiddenBelow);
                return;
            }
            // Focus travels upwards too — backspacing an empty row puts the caret
            // in the row above, which can be off the top of the screen.
            const hiddenAbove = visibleTop + gap - y;
            if (hiddenAbove > SLOP) scrollToOffset(offsetRef.current - hiddenAbove);
        });
    }, [gap, scrollToOffset]);

    /**
     * Focus, layout and the keyboard's own animation all land on different
     * frames. Wait for the container to actually be the size we just asked for:
     * scrolling before that gets clamped to the content it used to have, and
     * lands short by however much room we had just added.
     */
    const scrollSoon = useCallback(() => {
        requestAnimationFrame(() => requestAnimationFrame(keepFocusedInputVisible));
    }, [keepFocusedInputVisible]);

    useEffect(() => {
        if (!enabled) {
            keyboardTopRef.current = null;
            boundsRef.current = null;
            setKeyboardSpace(0);
            return;
        }

        const onShow = (event: KeyboardEvent) => {
            keyboardTopRef.current = event.endCoordinates.screenY;
            measureContainer();
        };
        const onHide = () => {
            keyboardTopRef.current = null;
            boundsRef.current = null;
            if (mountedRef.current) setKeyboardSpace(0);
        };

        const subscriptions = [
            // iOS says the keyboard is coming before it arrives, which is the
            // moment to make room — by the time it is up the container has
            // already grown and the scroll lands where it was asked to. Android
            // only ever says 'did', so there both happen at once and the frames
            // scrollSoon waits for are what let the new room count.
            Keyboard.addListener('keyboardWillShow', onShow),
            Keyboard.addListener('keyboardDidShow', event => { onShow(event); scrollSoon(); }),
            Keyboard.addListener('keyboardWillHide', onHide),
            Keyboard.addListener('keyboardDidHide', onHide),
        ];
        return () => subscriptions.forEach(subscription => subscription.remove());
    }, [enabled, measureContainer, scrollSoon]);

    // Moving from one input to the next while the keyboard is already up raises
    // no keyboard event at all, so this is the only thing that hears it.
    const onFocusCapture = useCallback(() => {
        requestAnimationFrame(keepFocusedInputVisible);
    }, [keepFocusedInputVisible]);

    const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        offsetRef.current = event.nativeEvent.contentOffset.y;
    }, []);

    const onScrollOffsetChange = useCallback((offset: number) => {
        offsetRef.current = offset;
    }, []);

    const scrollProps = useMemo(
        () => ({ onScroll, scrollEventThrottle: 16, onFocusCapture }),
        [onScroll, onFocusCapture],
    );
    const draggableProps = useMemo(
        () => ({ onScrollOffsetChange, onFocusCapture }),
        [onScrollOffsetChange, onFocusCapture],
    );

    return { scrollRef, keyboardSpace, scrollProps, draggableProps, keepFocusedInputVisible };
}

export default useKeyboardAwareScroll;
