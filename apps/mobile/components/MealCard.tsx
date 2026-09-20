import { Item, Meal } from "@/types/types";
import { mealPlaceholders } from "@/utils/mealPlaceholders";
import { parseQuantityAndText } from "@/utils/quantity";
import { nextListRank, rankAfter } from "@/utils/rank";
import { accentSoft, hairline, ink, inkFaint, inkMuted, primary } from "@/utils/styles";
import Ionicons from "@expo/vector-icons/Ionicons";
import { LexoRank } from "lexorank";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, LayoutAnimation, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Haptics from 'expo-haptics';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import Modal from 'react-native-modal';
import Animated, { FadeInLeft, FadeOutLeft, ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { GlassPressable, useGlassPreferences } from "./ui/Glass";
import uuid from 'react-native-uuid';

const DAYS: Meal['dayOfWeek'][] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface MealCardProps {
    meal: Meal;
    allItems: Item[];
    setAllItems: (callback: (prevItems: Item[]) => Item[]) => void;
    onUpdateMeal: (id: string, update: Partial<Meal>) => void;
    onDeleteMeal: (id: string) => void;
    onToggleCookbook: (meal: Meal) => void;
    editingId: string;
    setEditingId: React.Dispatch<React.SetStateAction<string>>;
    inputRefs: React.MutableRefObject<Record<string, TextInput | null>>;
    isKeyboardVisible: boolean;
    markDirty: () => void;
    onViewRecipe: (meal: Meal) => void;
    onAddRecipe: (meal: Meal) => void;
    isCollapsed: boolean;
    onToggleCollapse: (mealId: string) => void;
    onOpenQuantityEditor: (item: Item) => void;
}

function MealCard({
    meal,
    allItems,
    setAllItems,
    editingId,
    setEditingId,
    inputRefs,
    isKeyboardVisible,
    onUpdateMeal,
    onDeleteMeal,
    markDirty,
    onViewRecipe,
    onAddRecipe,
    isCollapsed,
    onToggleCollapse,
    onToggleCookbook,
    onOpenQuantityEditor
}: MealCardProps) {
    const hasRecipe = !!meal.recipeId;
    const { reduceMotion } = useGlassPreferences();
    const animateLayout = () => {
        if (!reduceMotion) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    };

    const [isDaySelectorVisible, setIsDaySelectorVisible] = useState(false);
    const [isMealNameEditing, setIsMealNameEditing] = useState(false);
    const mealNameInputRef = useRef<TextInput | null>(null);

    const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
    const [isMenuVisible, setIsMenuVisible] = useState(false);
    const [cookbookFeedback, setCookbookFeedback] = useState<string | null>(null);
    const cookbookFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const daySelectorProgress = useSharedValue(0);
    
    const daySelectorAnimatedStyle = useAnimatedStyle(() => ({
        opacity: daySelectorProgress.value,
        transform: [{ translateX: (1 - daySelectorProgress.value) * -10 }],
        maxHeight: daySelectorProgress.value * 100, // Animate height
    }));

    useEffect(() => {
        daySelectorProgress.value = reduceMotion ? (isDaySelectorVisible ? 1 : 0) : withSpring(isDaySelectorVisible ? 1 : 0, { damping: 23, stiffness: 220, reduceMotion: ReduceMotion.System });
    }, [isDaySelectorVisible, daySelectorProgress, reduceMotion]);

    useEffect(() => {
        if (isMealNameEditing) {
            setTimeout(() => mealNameInputRef.current?.focus(), 50);
        }
    }, [isMealNameEditing]);

    const placeholder = useMemo(() => {
        // Deterministic per meal so the placeholder doesn't shuffle on remount.
        let hash = 0;
        for (let i = 0; i < meal.id.length; i++) hash = (hash * 31 + meal.id.charCodeAt(i)) | 0;
        return mealPlaceholders[Math.abs(hash) % mealPlaceholders.length];
    }, [meal.id]);
    
    const ingredients = useMemo(
        () => allItems.filter(i => i.mealId === meal.id).sort((a, b) => (a.mealOrder && b.mealOrder) ? a.mealOrder.localeCompare(b.mealOrder) : 0),
        [allItems, meal.id]
    );

    const ingredientCount = ingredients.filter(item => item.text?.trim()).length;

    const assignRef = useCallback((id: string) => (ref: TextInput | null) => {
        inputRefs.current[id] = ref;
    }, [inputRefs]);

    const handleItemBlur = (item: Item) => {
        const { quantity, text: newText } = parseQuantityAndText(item.text);
        
        if (quantity || newText !== item.text) {
            setAllItems(prev =>
                prev.map(i =>
                    i.id === item.id
                        ? { ...i, text: newText, quantity: quantity || i.quantity, section: undefined }
                        : i
                )
            );
            markDirty();
        }
        
        setEditingId('');
    };

    const handleDaySelect = (day: Meal['dayOfWeek']) => {
        const newDay = meal.dayOfWeek === day ? undefined : day;
        onUpdateMeal(meal.id, { dayOfWeek: newDay });
        animateLayout();
        setIsDaySelectorVisible(false);
        markDirty();
    };

    const toggleDaySelector = () => {
        animateLayout();
        setIsDaySelectorVisible(prev => !prev);
    };

    // An ingredient is a grocery row too, and the aisle it was filed under was
    // decided from the old text — drop it so the list re-files this row once the
    // edit settles.
    const handleUpdateIngredientText = (id: string, text: string) => {
        setAllItems(prev => prev.map(item => (item.id === id ? { ...item, text, section: undefined } : item)));
        markDirty();
    };

    const handleToggleCheck = (id: string) => {
        Haptics.selectionAsync().catch(() => {});
        setAllItems(prev => prev.map(item => (item.id === id ? { ...item, checked: !item.checked } : item)));
        markDirty();
    };

    const handleDeleteIngredient = (id: string) => {
        const index = ingredients.findIndex(i => i.id === id);
        if (index === -1) return;
        delete inputRefs.current[id];

        setAllItems(prev => prev.filter(item => item.id !== id));
        markDirty();

        // Deleting the first ingredient used to clamp to ingredients[0] — the
        // row being deleted — so editingId pointed at an item that no longer
        // existed. Nothing could clear it from there, and the list screen's
        // auto-sort bails out while editingId is set.
        const prevFocusId = index > 0 ? ingredients[index - 1].id : '';
        setEditingId(isKeyboardVisible ? prevFocusId : '');
    };

    const handleAddIngredient = (afterIndex: number | undefined) => {
        if(afterIndex === undefined) afterIndex = ingredients.length -1;
        // rankAfter scans outward to the nearest ingredient that actually has a
        // parseable mealOrder. The old code fell back to LexoRank.middle() when
        // the anchor's rank was missing, which turned "insert after this one"
        // into "jump to the middle of the meal".
        const mealRank = afterIndex < 0 || ingredients.length === 0
            ? LexoRank.middle()
            : rankAfter(ingredients, afterIndex, 'mealOrder');

        const listRank = nextListRank(allItems);

        const newItem: Item = {
            id: uuid.v4() as string,
            text: '',
            checked: false,
            mealOrder: mealRank.toString(),
            listOrder: listRank.toString(),
            isSection: false,
            mealId: meal.id,
        };

        setAllItems(prev => [...prev, newItem]);
        setEditingId(newItem.id);
        markDirty();
    };
    const handleDragEnd = ({ data }: { data: Item[] }) => {
        let rank = LexoRank.middle();
        const reRankedIngredients = data.map(item => {
            rank = rank.genNext();
            return { ...item, mealOrder: rank.toString() };
        });

        setAllItems(prevAllItems => {
            const otherItems = prevAllItems.filter(item => item.mealId !== meal.id);
            return [...otherItems, ...reRankedIngredients];
        });
        markDirty();
    };

    const renderIngredient = useCallback(({ item, drag, isActive, getIndex }: RenderItemParams<Item>) => {
        const isEditing = item.id === editingId;
        return (
            <View style={styles.itemRow}>
                {/* Long-press to drag, matching GroceryListView. onPressIn grabbed
                    the gesture the instant you touched the handle, so a downward
                    swipe that started anywhere near it became a reorder instead
                    of scrolling the meal plan. */}
                <Pressable
                    onLongPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); drag(); }}
                    style={styles.dragHandle}
                    hitSlop={20}
                    disabled={isActive}
                >
                    <Text style={styles.dragIcon}>≡</Text>
                </Pressable>
                <GlassPressable haptic={false} hitSlop={10} style={[styles.checkbox, item.checked && styles.checkboxChecked]} onPress={() => handleToggleCheck(item.id)} accessibilityRole="checkbox" accessibilityState={{ checked: item.checked }} accessibilityLabel={`Mark ${item.text || "ingredient"} ${item.checked ? "not bought" : "bought"}`}>
                    {item.checked && <Ionicons name="checkmark" size={15} color="#fff" />}
                </GlassPressable>
                { item.quantity && (
                    <GlassPressable onPress={() => onOpenQuantityEditor(item)} accessibilityLabel={`Edit quantity for ${item.text || "ingredient"}`}>
                        <View style={[styles.quantityLabel, item.checked && styles.quantityChecked]}>
                            <Text style={[item.checked && styles.quantityTextChecked]}>{item.quantity}</Text>
                        </View>
                    </GlassPressable>
                )}
                <TextInput
                    ref={assignRef(item.id)}
                    value={item.text}
                    style={[styles.editInput, item.checked && styles.checked]}
                    accessibilityLabel="Ingredient name"
                    onChangeText={text => handleUpdateIngredientText(item.id, text)}
                    onFocus={() => setEditingId(item.id)}
                    onKeyPress={({ nativeEvent }) => {
                        if (nativeEvent.key === 'Backspace' && item.text === '') {
                            handleDeleteIngredient(item.id);
                        }
                    }}
                    onSubmitEditing={() => {
                        // Return on a row with nothing in it is the user
                        // finishing, not asking for one more empty row.
                        if ((item.text ?? '').trim() === '') {
                            setEditingId('');
                            Keyboard.dismiss();
                            return;
                        }
                        handleAddIngredient(getIndex());
                    }}
                    onBlur={() => handleItemBlur(item)}
                    blurOnSubmit={false}
                    returnKeyType="next"
                />
                {isEditing && (
                    // onPressIn: the input's onBlur clears editingId and unmounts
                    // this button before a regular onPress can fire.
                    <GlassPressable onPressIn={() => handleDeleteIngredient(item.id)} onPress={() => handleDeleteIngredient(item.id)} style={styles.clearButton} hitSlop={8} accessibilityLabel={`Delete ${item.text || "ingredient"}`}>
                        <Text style={styles.clearText}>✕</Text>
                    </GlassPressable>
                )}
            </View>
        );
    }, [editingId, ingredients]);


    /**
     * Toggles the cookbook and shows a short confirmation beside the icon.
     * `meal.addedToCookbook` is the value BEFORE the toggle, so the message
     * describes what the press just did rather than the state it came from.
     */
    const handleToggleCookbook = () => {
        const nowAdded = !meal.addedToCookbook;
        onToggleCookbook(meal);
        setCookbookFeedback(nowAdded ? 'Added to Cookbook' : 'Removed from Cookbook');

        if (cookbookFeedbackTimer.current) clearTimeout(cookbookFeedbackTimer.current);
        cookbookFeedbackTimer.current = setTimeout(() => setCookbookFeedback(null), 2000);
    };

    // Don't set state on an unmounted card — meals get removed from the plan.
    useEffect(() => () => {
        if (cookbookFeedbackTimer.current) clearTimeout(cookbookFeedbackTimer.current);
    }, []);

    const handleDeletePress = () => {
        animateLayout();
        setIsConfirmingDelete(true);
    };

    const handleCancelDelete = () => {
        animateLayout();
        setIsConfirmingDelete(false);
    };

    const handleConfirmDelete = () => {
        onDeleteMeal(meal.id);
    };

    if (isConfirmingDelete) {
        return (
            <View style={[styles.mealCard, styles.confirmationContainer]}>
                {/* "Remove from meal plan", not "Delete" — the recipe itself is
                    untouched, and only this week's plan changes. */}
                <Text style={styles.confirmationTitle}>
                    Remove {meal.name ? `"${meal.name}"` : 'this meal'} from meal plan?
                </Text>
                <View style={styles.confirmationButtons}>
                    <GlassPressable style={[styles.confirmationButton, styles.cancelButton]} onPress={handleCancelDelete}>
                        <Text style={styles.cancelButtonText}>Cancel</Text>
                    </GlassPressable>
                    <GlassPressable style={[styles.confirmationButton, styles.confirmButton]} onPress={handleConfirmDelete}>
                        <Text style={styles.confirmButtonText}>Remove</Text>
                    </GlassPressable>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.mealCard}>
            <View>
                <View style={styles.mealCardUpper}>
                    <GlassPressable onPress={toggleDaySelector} style={styles.dayPickerCollapsed} accessibilityLabel={`Choose a day for this meal, ${meal.dayOfWeek || "any day"}`} accessibilityState={{ expanded: isDaySelectorVisible }}>
                        <Ionicons name="calendar-outline" size={14} color={primary} />
                        <Text style={styles.selectedDayText}>{meal.dayOfWeek || 'Any day'}</Text>
                        <Ionicons name="chevron-down" size={11} color={primary} />
                    </GlassPressable>
                    <Text style={styles.ingredientCount}>{ingredientCount} ingredient{ingredientCount === 1 ? '' : 's'}</Text>
                    <GlassPressable
                        onPress={() => setIsMenuVisible(true)}
                        style={styles.deleteButton}
                        hitSlop={10}
                        accessibilityLabel="Meal options"
                    >
                        <Ionicons name="ellipsis-horizontal" size={20} color={inkMuted} />
                    </GlassPressable>
                </View>
                {isDaySelectorVisible && (
                    <Animated.View style={[styles.daySelectorContainer, daySelectorAnimatedStyle]}>
                        {DAYS.map((day) => (
                            <GlassPressable key={day} hitSlop={5} style={[styles.dayButton, meal.dayOfWeek === day && styles.dayButtonActive]} onPress={() => handleDaySelect(day)} accessibilityLabel={day} accessibilityState={{ selected: meal.dayOfWeek === day }}>
                                <Text style={[styles.dayText, meal.dayOfWeek === day && styles.dayTextActive]}>{day?.slice(0, 2)}</Text>
                            </GlassPressable>
                        ))}
                    </Animated.View>
                )}
                <View>
                    <View style={styles.mealHeaderUpper}>
                        <GlassPressable onPress={() => { animateLayout(); onToggleCollapse(meal.id); }} style={styles.collapseButton} accessibilityLabel={isCollapsed ? "Show ingredients" : "Hide ingredients"} accessibilityState={{ expanded: !isCollapsed }}>
                            <Ionicons name={isCollapsed ? "chevron-forward" : "chevron-down"} size={17} color={primary} />
                        </GlassPressable>
                        {/* An unnamed meal stays a live text field with its
                            placeholder — that's the fastest path for a brand new
                            meal. Once it HAS a name, tapping it collapses like
                            the chevron, and the pencil is how you rename. onFocus
                            latches editing so typing the first character doesn't
                            flip it out from under the cursor. */}
                        <View style={styles.mealNameContainer}>
                            {(!meal.name || isMealNameEditing) ? (
                                <TextInput
                                    ref={(ref) => {
                                        mealNameInputRef.current = ref;
                                        assignRef(meal.id)(ref);
                                    }}
                                    style={styles.mealName}
                                    accessibilityLabel="Meal name"
                                    value={meal.name}
                                    onChangeText={(text) => onUpdateMeal(meal.id, { name: text })}
                                    placeholder={placeholder}
                                    placeholderTextColor={inkFaint}
                                    onFocus={() => setIsMealNameEditing(true)}
                                    onBlur={() => setIsMealNameEditing(false)}
                                />
                            ) : (
                                <View style={styles.mealNameRow}>
                                    <GlassPressable
                                        onPress={() => { animateLayout(); onToggleCollapse(meal.id); }}
                                        style={styles.mealNameTap}
                                    >
                                        <Text style={styles.mealName}>{meal.name}</Text>
                                    </GlassPressable>
                                    <GlassPressable
                                        onPress={() => setIsMealNameEditing(true)}
                                        style={styles.editNameButton}
                                        hitSlop={12}
                                        accessibilityLabel="Rename meal"
                                    >
                                        <Ionicons name="pencil" size={15} color={inkFaint} />
                                    </GlassPressable>
                                </View>
                            )}
                        </View>
                    </View>
                    {hasRecipe ? (
                        <View style={styles.mealHeaderLower}>
                            <GlassPressable style={styles.recipeIndicator} onPress={() => onViewRecipe(meal)}>
                                <Ionicons name="book-outline" size={16} color={primary} />
                                <Text style={styles.recipeIndicatorText}>View Recipe</Text>
                            </GlassPressable>
                            {/* Icon-only until you press it: the filled/outline
                                bookmark already says whether it's saved, so the
                                permanent label was just noise. The confirmation
                                text animates in on press and clears itself. */}
                            <GlassPressable style={styles.recipeIndicator} onPress={handleToggleCookbook} accessibilityLabel={meal.addedToCookbook ? "Remove from cookbook" : "Save to cookbook"} accessibilityState={{ selected: !!meal.addedToCookbook }}>
                                <Ionicons
                                    name={meal.addedToCookbook ? 'bookmark' : 'bookmark-outline'}
                                    size={16}
                                    color={primary}
                                />
                                {cookbookFeedback && (
                                    <Animated.Text
                                        entering={FadeInLeft.duration(180).reduceMotion(ReduceMotion.System)}
                                        exiting={FadeOutLeft.duration(180).reduceMotion(ReduceMotion.System)}
                                        style={styles.recipeIndicatorText}
                                    >
                                        {cookbookFeedback}
                                    </Animated.Text>
                                )}
                            </GlassPressable>
                        </View>
                    ) : (
                        <View style={styles.mealHeaderLower}>
                            <GlassPressable style={styles.recipeIndicator} onPress={() => onAddRecipe(meal)}>
                                <Ionicons name="add" size={16} color={primary} />
                                <Text style={styles.recipeIndicatorText}>Add Recipe</Text>
                            </GlassPressable>
                        </View>
                    )}
                </View>
            </View>
            {!isCollapsed && (
                <View style={styles.ingredientListContainer}>
                    <DraggableFlatList
                        data={ingredients}
                        onDragEnd={handleDragEnd}
                        keyExtractor={(item) => item.id}
                        renderItem={renderIngredient}
                        containerStyle={{ flex: 1 }}
                        // This list is nested inside MealPlanView's FlatList. As
                        // its own scroll container it swallowed every vertical
                        // pan, so the meal plan couldn't be scrolled by dragging
                        // over a meal. A meal holds a handful of ingredients, so
                        // it doesn't need to scroll — let the outer list do it.
                        scrollEnabled={false}
                        // Require a deliberate movement before a drag takes over
                        // the gesture, rather than the first pixel of travel.
                        activationDistance={16}
                        // The ingredient row's ✕ is only rendered while that
                        // row's input has focus, so its every press arrives with
                        // the keyboard up. On the default ('never') this list
                        // captures that press to dismiss the keyboard and the
                        // button never sees it — the delete looked like a no-op.
                        keyboardShouldPersistTaps="handled"
                        initialNumToRender={15}
                        maxToRenderPerBatch={10}
                        windowSize={10}
                    />
                    {ingredients.length === 0 && (
                        <GlassPressable
                            style={styles.addFirstIngredientButton}
                            onPress={() => handleAddIngredient(-1)}>
                            <Text style={styles.addIngredientText}>+ Add Ingredient</Text>
                        </GlassPressable>
                    )}
                </View>
            )}

            {/* Rendered only while open — every meal in the plan mounts a
                MealCard, and a permanently-mounted Modal each would be a lot of
                idle components for something used one at a time. */}
            {isMenuVisible && (
                <Modal
                    isVisible={isMenuVisible}
                    onBackdropPress={() => setIsMenuVisible(false)}
                    onBackButtonPress={() => setIsMenuVisible(false)}
                    swipeDirection="down"
                    onSwipeComplete={() => setIsMenuVisible(false)}
                    backdropOpacity={0.25}
                    animationInTiming={reduceMotion ? 0 : 300}
                    animationOutTiming={reduceMotion ? 0 : 250}
                    style={styles.menuModal}
                    useNativeDriverForBackdrop
                >
                    <SafeAreaView style={styles.menuSheet}>
                        <View style={styles.menuGrabberContainer}>
                            <View style={styles.menuGrabber} />
                        </View>
                        <Text style={styles.menuTitle} numberOfLines={1}>
                            {meal.name || 'Untitled meal'}
                        </Text>

                        <GlassPressable
                            style={styles.menuRow}
                            onPress={() => { setIsMenuVisible(false); handleDeletePress(); }}
                        >
                            <Ionicons name="close-circle-outline" size={22} color="#db6767ff" />
                            <Text style={[styles.menuRowText, styles.menuRowDanger]}>Remove from Meal Plan</Text>
                        </GlassPressable>
                    </SafeAreaView>
                </Modal>
            )}
        </View>
    );
}


const styles = StyleSheet.create({
    mealNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    mealNameTap: { flexShrink: 1 },
    editNameButton: { padding: 2 },
    menuModal: { justifyContent: 'flex-end', margin: 0 },
    menuSheet: { backgroundColor: '#F5F5EF', borderTopLeftRadius: 32, borderTopRightRadius: 32, paddingBottom: 20 },
    menuGrabberContainer: { alignItems: 'center', paddingTop: 12 },
    menuGrabber: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#d0d0d0' },
    menuTitle: { fontSize: 16, fontWeight: '600', color: inkMuted, textAlign: 'center', marginTop: 12, marginBottom: 8, paddingHorizontal: 24 },
    menuRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 16, paddingHorizontal: 24 },
    menuRowText: { fontSize: 17, fontWeight: '500', color: ink },
    menuRowDanger: { color: '#db6767ff' },
    mealCard: { backgroundColor: 'rgba(255,255,255,0.86)', padding: 18, borderRadius: 28, marginBottom: 15, borderWidth: 1, borderColor: 'rgba(255,255,255,0.96)', shadowColor: '#173F35', shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.035, shadowRadius: 12, elevation: 1 },
    mealHeaderUpper: { marginTop: 16, marginBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    mealHeaderLower: {
        flexDirection: 'row',
        marginLeft: 31,
        flexWrap: 'wrap',
        rowGap: 8
    },
    collapseButton: { padding: 4, alignSelf: 'flex-start', marginTop: 4 },
    collapseIcon: { fontSize: 16 },
    mealNameContainer: { flex: 1, marginLeft: 6 },
    mealName: { fontWeight: '700', fontSize: 22, lineHeight: 28, color: ink, letterSpacing: -0.65 },
    placeholderText: { color: inkFaint, fontWeight: 'normal' },
    deleteButton: { padding: 6, borderRadius: 16, backgroundColor: 'rgba(23,63,53,0.035)' },
    ingredientCount: { flex: 1, textAlign: 'right', marginRight: 12, color: inkMuted, fontSize: 11, fontWeight: '500' },
    settingsIcon: { fontSize: 20 },
    ingredientListContainer: { paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hairline, marginTop: 10 },
    daySelectorContainer: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        paddingTop: 12,
        overflow: 'hidden',
    },
    dayButton: {
        width: 33,
        height: 33,
        borderRadius: 17,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: accentSoft,
        marginHorizontal: 2
    },
    dayButtonActive: {
        backgroundColor: primary,
    },
    dayText: {
        fontWeight: '600',
        color: inkMuted,
    },
    dayTextActive: {
        color: '#fff',
    },
    confirmationContainer: {
        alignItems: 'center',
        paddingVertical: 20,
    },
    confirmationTitle: {
        fontSize: 17,
        fontWeight: '600',
        color: ink,
        marginBottom: 16,
        textAlign: 'center',
    },
    confirmationButtons: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        width: '100%',
    },
    confirmationButton: {
        paddingVertical: 10,
        paddingHorizontal: 24,
        borderRadius: 20,
        borderWidth: 1,
    },
    cancelButton: {
        borderColor: hairline,
        backgroundColor: '#fff',
    },
    cancelButtonText: {
        color: inkMuted,
        fontWeight: '600',
    },
    confirmButton: {
        borderColor: '#dc3545',
        backgroundColor: '#dc3545',
    },
    confirmButtonText: {
        color: '#fff',
        fontWeight: '600',
    },
    itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, minHeight: 46 },
    dragHandle: { width: 20, alignItems: 'center', justifyContent: 'center' },
    dragIcon: { fontSize: 18, color: inkFaint },
    checkbox: { width: 23, height: 23, marginLeft: 6, marginRight: 10, borderWidth: 1.5, borderColor: '#C5D2C8', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    checkboxChecked: { backgroundColor: primary, borderColor: primary },
    editInput: { fontSize: 16, flex: 1, paddingVertical: 2, color: ink },
    checked: { textDecorationLine: 'line-through', color: inkFaint },
    quantityChecked: { backgroundColor: '#eeeeee' },
    quantityTextChecked: { textDecorationLine: 'line-through', color: inkFaint },
    clearButton: { paddingHorizontal: 8 },
    clearText: { fontSize: 16, color: inkFaint },
    addFirstIngredientButton: { paddingVertical: 9, paddingLeft: 30 },
    addIngredientText: { color: primary, fontSize: 14, fontWeight: '600' },
    mealCardUpper: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        margin: 0,
        padding: 0,
        alignItems: 'center',
        height:30
    },
    dayPickerContainer: {
        flexDirection: 'row',
        justifyContent: 'flex-start',
        margin: 0,
        padding: 0,
        alignItems: 'center',
        height:30
    },
    dayPickerCollapsed: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: accentSoft,
        borderRadius: 18,
        paddingVertical: 7,
        paddingHorizontal: 10,
    },
    selectedDayText: {
        fontSize: 12,
        fontWeight: '600',
        color: primary,
    },
    recipeIndicator: {
        width: 'auto',
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 7,
        paddingHorizontal: 10,
        backgroundColor: accentSoft,
        borderRadius: 999,
        marginRight: 8,
    },
    recipeIndicatorText: {
        marginLeft: 5,
        color: primary,
        fontWeight: '500',
        fontSize: 12,
    },
    quantityLabel: {
        backgroundColor: accentSoft,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 8,
        marginHorizontal: 3
    },
});

export default React.memo(MealCard);