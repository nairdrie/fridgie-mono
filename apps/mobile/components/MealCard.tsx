import { Item, Meal } from "@/types/types";
import { mealPlaceholders } from "@/utils/mealPlaceholders";
import { parseQuantityAndText } from "@/utils/quantity";
import { nextListRank, rankAfter, safeParseRank } from "@/utils/rank";
import { accentSoft, hairline, ink, inkFaint, inkMuted, primary, surface } from "@/utils/styles";
import Ionicons from "@expo/vector-icons/Ionicons";
import { LexoRank } from "lexorank";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, LayoutAnimation, Pressable, SafeAreaView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import * as Haptics from 'expo-haptics';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import Modal from 'react-native-modal';
import Animated, { FadeInLeft, FadeOutLeft, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
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
        daySelectorProgress.value = withTiming(isDaySelectorVisible ? 1 : 0, { duration: 300 });
    }, [isDaySelectorVisible]);

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
    
    const mealNameDisplay = useMemo(() => {
        if (!meal.name || meal.name.length <= 32) {
            return meal.name;
        }
        return `${meal.name.substring(0, 32)}...`;
    }, [meal.name]);

    const ingredients = useMemo(
        () => allItems.filter(i => i.mealId === meal.id).sort((a, b) => (a.mealOrder && b.mealOrder) ? a.mealOrder.localeCompare(b.mealOrder) : 0),
        [allItems, meal.id]
    );

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
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setIsDaySelectorVisible(false);
        markDirty();
    };

    const toggleDaySelector = () => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
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
                    onLongPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); drag(); }}
                    style={styles.dragHandle}
                    hitSlop={20}
                    disabled={isActive}
                >
                    <Text style={styles.dragIcon}>≡</Text>
                </Pressable>
                <TouchableOpacity style={styles.checkbox} onPress={() => handleToggleCheck(item.id)}>
                    {item.checked && <Text>✓</Text>}
                </TouchableOpacity>
                { item.quantity && (
                    <TouchableOpacity onPress={() => onOpenQuantityEditor(item)}>
                        <View style={[styles.quantityLabel, item.checked && styles.quantityChecked]}>
                            <Text style={[item.checked && styles.quantityTextChecked]}>{item.quantity}</Text>
                        </View>
                    </TouchableOpacity>
                )}
                <TextInput
                    ref={assignRef(item.id)}
                    value={item.text}
                    style={[styles.editInput, item.checked && styles.checked]}
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
                    <TouchableOpacity onPressIn={() => handleDeleteIngredient(item.id)} style={styles.clearButton} hitSlop={8}>
                        <Text style={styles.clearText}>✕</Text>
                    </TouchableOpacity>
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
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setIsConfirmingDelete(true);
    };

    const handleCancelDelete = () => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
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
                    <TouchableOpacity style={[styles.confirmationButton, styles.cancelButton]} onPress={handleCancelDelete}>
                        <Text style={styles.cancelButtonText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.confirmationButton, styles.confirmButton]} onPress={handleConfirmDelete}>
                        <Text style={styles.confirmButtonText}>Remove</Text>
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.mealCard}>
            <View>
                <View style={styles.mealCardUpper}>
                    <View style={styles.dayPickerContainer}>
                        <TouchableOpacity onPress={toggleDaySelector} style={styles.dayPickerCollapsed}>
                            <Ionicons name="calendar-outline" size={18} color={primary} />
                            {meal.dayOfWeek && !isDaySelectorVisible && (
                                <Text style={styles.selectedDayText}>{meal.dayOfWeek}</Text>
                            )}
                            {!meal.dayOfWeek && !isDaySelectorVisible && (
                                <Text style={styles.selectedDayText}>Select Day</Text>
                            )}
                        </TouchableOpacity>

                        {isDaySelectorVisible && (
                            <Animated.View style={[styles.daySelectorContainer, daySelectorAnimatedStyle]}>
                                {DAYS.map((day) => (
                                    <TouchableOpacity
                                        key={day}
                                        style={[styles.dayButton, meal.dayOfWeek === day && styles.dayButtonActive]}
                                        onPress={() => handleDaySelect(day)}
                                    >
                                        <Text style={[styles.dayText, meal.dayOfWeek === day && styles.dayTextActive]}>
                                            {day?.charAt(0)}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </Animated.View>
                        )}
                    </View>
                    <TouchableOpacity
                        onPress={() => setIsMenuVisible(true)}
                        style={styles.deleteButton}
                        hitSlop={10}
                        accessibilityLabel="Meal options"
                    >
                        <Ionicons name="ellipsis-horizontal" size={20} color="#8a8a8a" />
                    </TouchableOpacity>
                </View>
                <View>
                    <View style={styles.mealHeaderUpper}>
                        <TouchableOpacity onPress={() => onToggleCollapse(meal.id)} style={styles.collapseButton}>
                            <Text style={styles.collapseIcon}>{isCollapsed ? '▶' : '▼'}</Text>
                        </TouchableOpacity>
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
                                    value={meal.name}
                                    onChangeText={(text) => onUpdateMeal(meal.id, { name: text })}
                                    placeholder={placeholder}
                                    placeholderTextColor={'grey'}
                                    onFocus={() => setIsMealNameEditing(true)}
                                    onBlur={() => setIsMealNameEditing(false)}
                                />
                            ) : (
                                <View style={styles.mealNameRow}>
                                    <TouchableOpacity
                                        onPress={() => onToggleCollapse(meal.id)}
                                        style={styles.mealNameTap}
                                    >
                                        <Text style={styles.mealName}>{mealNameDisplay}</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        onPress={() => setIsMealNameEditing(true)}
                                        style={styles.editNameButton}
                                        hitSlop={12}
                                        accessibilityLabel="Rename meal"
                                    >
                                        <Ionicons name="pencil" size={15} color="#9a9a9a" />
                                    </TouchableOpacity>
                                </View>
                            )}
                        </View>
                    </View>
                    {hasRecipe ? (
                        <View style={styles.mealHeaderLower}>
                            <TouchableOpacity style={styles.recipeIndicator} onPress={() => onViewRecipe(meal)}>
                                <Ionicons name="book-outline" size={16} color={primary} />
                                <Text style={styles.recipeIndicatorText}>View Recipe</Text>
                            </TouchableOpacity>
                            {/* Icon-only until you press it: the filled/outline
                                bookmark already says whether it's saved, so the
                                permanent label was just noise. The confirmation
                                text animates in on press and clears itself. */}
                            <TouchableOpacity style={styles.recipeIndicator} onPress={handleToggleCookbook}>
                                <Ionicons
                                    name={meal.addedToCookbook ? 'bookmark' : 'bookmark-outline'}
                                    size={16}
                                    color={primary}
                                />
                                {cookbookFeedback && (
                                    <Animated.Text
                                        entering={FadeInLeft.duration(180)}
                                        exiting={FadeOutLeft.duration(180)}
                                        style={styles.recipeIndicatorText}
                                    >
                                        {cookbookFeedback}
                                    </Animated.Text>
                                )}
                            </TouchableOpacity>
                        </View>
                    ) : (
                        <View style={styles.mealHeaderLower}>
                            <TouchableOpacity style={styles.recipeIndicator} onPress={() => onAddRecipe(meal)}>
                                <Ionicons name="add" size={16} color={primary} />
                                <Text style={styles.recipeIndicatorText}>Add Recipe</Text>
                            </TouchableOpacity>
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
                        <TouchableOpacity
                            style={styles.addFirstIngredientButton}
                            onPress={() => handleAddIngredient(-1)}>
                            <Text style={styles.addIngredientText}>+ Add Ingredient</Text>
                        </TouchableOpacity>
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
                    backdropOpacity={0.4}
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

                        <TouchableOpacity
                            style={styles.menuRow}
                            onPress={() => { setIsMenuVisible(false); handleDeletePress(); }}
                        >
                            <Ionicons name="close-circle-outline" size={22} color="#db6767ff" />
                            <Text style={[styles.menuRowText, styles.menuRowDanger]}>Remove from Meal Plan</Text>
                        </TouchableOpacity>
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
    menuSheet: { backgroundColor: '#f8f9fa', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 8 },
    menuGrabberContainer: { alignItems: 'center', paddingTop: 12 },
    menuGrabber: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#d0d0d0' },
    menuTitle: { fontSize: 16, fontWeight: '600', color: inkMuted, textAlign: 'center', marginTop: 12, marginBottom: 8, paddingHorizontal: 24 },
    menuRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 16, paddingHorizontal: 24 },
    menuRowText: { fontSize: 17, fontWeight: '500', color: ink },
    menuRowDanger: { color: '#db6767ff' },
    // Flat fill instead of a drop shadow: these stack several deep in a plan,
    // and the shadows used to pile up into visible bands between them.
    mealCard: { backgroundColor: surface, padding: 14, borderRadius: 14, marginBottom: 10 },
    mealHeaderUpper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    mealHeaderLower: {
        flexDirection: 'row',
        marginLeft: 35
    },
    collapseButton: { padding: 5 },
    collapseIcon: { fontSize: 16 },
    mealNameContainer: { flex: 1, marginHorizontal: 10 },
    mealName: { fontWeight: '600', fontSize: 18, color: ink, letterSpacing: -0.2 },
    placeholderText: { color: inkFaint, fontWeight: 'normal' },
    deleteButton: { padding: 5 },
    settingsIcon: { fontSize: 20 },
    ingredientListContainer: { paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hairline, marginTop: 10 },
    daySelectorContainer: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        paddingHorizontal: 20,
    },
    dayButton: {
        width: 28,
        height: 28,
        borderRadius: 14,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: hairline,
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
    itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5 },
    dragHandle: { width: 30, alignItems: 'center', justifyContent: 'center' },
    dragIcon: { fontSize: 18, color: inkFaint },
    checkbox: { width: 24, height: 24, marginHorizontal: 10, borderWidth: 1.5, borderColor: '#cfd4cb', borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
    editInput: { fontSize: 16, flex: 1, paddingVertical: 2, color: ink },
    checked: { textDecorationLine: 'line-through', color: inkFaint },
    quantityChecked: { backgroundColor: '#eeeeee' },
    quantityTextChecked: { textDecorationLine: 'line-through', color: inkFaint },
    clearButton: { paddingHorizontal: 8 },
    clearText: { fontSize: 16, color: inkFaint },
    addFirstIngredientButton: { paddingVertical: 5, paddingLeft: 40 },
    addIngredientText: { color: primary, fontSize: 16 },
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
        alignItems: 'center'
    },
    selectedDayText: {
        marginLeft: 8,
        fontSize: 16,
        color: primary,
    },
    recipeIndicator: {
        width: 'auto',
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 4,
        paddingHorizontal: 8,
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
        backgroundColor: '#e9ece6',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 6,
        marginHorizontal: 3
    },
});

export default React.memo(MealCard);