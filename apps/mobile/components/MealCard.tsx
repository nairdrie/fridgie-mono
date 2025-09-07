import { Item, Meal } from "@/types/types";
import { mealPlaceholders } from "@/utils/mealPlaceholders";
import { primary } from "@/utils/styles";
import Ionicons from "@expo/vector-icons/Ionicons";
import { LexoRank } from "lexorank";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutAnimation, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import uuid from 'react-native-uuid';
import { parseQuantityAndText } from "./QuantityEditorModal";

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
        return mealPlaceholders[Math.floor(Math.random() * mealPlaceholders.length)];
    }, []);
    
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
                        ? { ...i, text: newText, quantity: quantity || i.quantity }
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

    const handleUpdateIngredientText = (id: string, text: string) => {
        setAllItems(prev => prev.map(item => (item.id === id ? { ...item, text } : item)));
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

        if (isKeyboardVisible) {
            const nextFocusId = ingredients[Math.max(0, index - 1)]?.id;
            if (nextFocusId) {
                setEditingId(nextFocusId);
            }
        } else {
            setEditingId('');
        }
    };

    const handleAddIngredient = (afterIndex: number | undefined) => {
        if(afterIndex === undefined) afterIndex = ingredients.length -1;
        let mealRank: LexoRank;
        if (afterIndex < 0 || ingredients.length === 0) {
            mealRank = LexoRank.middle();
        } else {
            const current = LexoRank.parse(ingredients[afterIndex].mealOrder!);
            const next = ingredients[afterIndex + 1] ? LexoRank.parse(ingredients[afterIndex + 1].mealOrder!) : current.genNext();
            mealRank = current.between(next);
        }
        
        const lastItem = allItems[allItems.length - 1];
        const listRank = lastItem ? LexoRank.parse(lastItem.listOrder).genNext() : LexoRank.middle();

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
                <Pressable onPressIn={drag} style={styles.dragHandle} hitSlop={20} disabled={isActive}>
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
                    onSubmitEditing={() => handleAddIngredient(getIndex())}
                    onBlur={() => handleItemBlur(item)}
                    blurOnSubmit={false}
                    returnKeyType="next"
                />
                {isEditing && (
                    <TouchableOpacity onPress={() => handleDeleteIngredient(item.id)} style={styles.clearButton}>
                        <Text style={styles.clearText}>✕</Text>
                    </TouchableOpacity>
                )}
            </View>
        );
    }, [editingId, ingredients]);


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
                <Text style={styles.confirmationTitle}>Delete {meal.name ? `"${meal.name}"` : 'meal'}?</Text>
                <View style={styles.confirmationButtons}>
                    <TouchableOpacity style={[styles.confirmationButton, styles.cancelButton]} onPress={handleCancelDelete}>
                        <Text style={styles.cancelButtonText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.confirmationButton, styles.confirmButton]} onPress={handleConfirmDelete}>
                        <Text style={styles.confirmButtonText}>Confirm</Text>
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.mealCard}>
            <View style={styles.mainContent}>
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
                    <TouchableOpacity onPress={handleDeletePress} style={styles.deleteButton}>
                        <Ionicons name="trash" size={18} color="#db6767ff" /> 
                    </TouchableOpacity>
                </View>
                <View style={styles.mealHeader}>
                    <View style={styles.mealHeaderUpper}>
                        <TouchableOpacity onPress={() => onToggleCollapse(meal.id)} style={styles.collapseButton}>
                            <Text style={styles.collapseIcon}>{isCollapsed ? '▶' : '▼'}</Text>
                        </TouchableOpacity>
                        <View style={styles.mealNameContainer}>
                            {isMealNameEditing ? (
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
                                    onBlur={() => setIsMealNameEditing(false)}
                                />
                            ) : (
                                <TouchableOpacity onPress={() => setIsMealNameEditing(true)}>
                                    <Text style={[styles.mealName, !meal.name && styles.placeholderText]}>
                                        {meal.name ? mealNameDisplay : placeholder}
                                    </Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    </View>
                    {hasRecipe ? (
                        <View style={styles.mealHeaderLower}>
                            <TouchableOpacity style={styles.recipeIndicator} onPress={() => onViewRecipe(meal)}>
                                <Ionicons name="book-outline" size={16} color={primary} />
                                <Text style={styles.recipeIndicatorText}>View Recipe</Text>
                            </TouchableOpacity>
                            { meal.addedToCookbook ? (
                                <TouchableOpacity style={styles.recipeIndicator} onPress={() => onToggleCookbook(meal)}>
                                    <Ionicons name="bookmark" size={16} color={primary} />
                                    <Text style={styles.recipeIndicatorText}>Added to Cookbook</Text>
                                </TouchableOpacity>
                            ) : (
                                <TouchableOpacity style={styles.recipeIndicator} onPress={() => onToggleCookbook(meal)}>
                                    <Ionicons name="bookmark-outline" size={16} color={primary} />
                                    <Text style={styles.recipeIndicatorText}>Add to Cookbook</Text>
                                </TouchableOpacity>
                            )
                            }
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
                        simultaneousHandlers={[]} 
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
        </View>
    );
}


const styles = StyleSheet.create({
    mealCard: { backgroundColor: '#f9f9f9', padding: 12, borderRadius: 8, marginBottom: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2, elevation: 2 },
    mealHeader: {

    },
    mealHeaderUpper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    mealHeaderLower: {
        flexDirection: 'row',
        marginLeft: 35
    },
    collapseButton: { padding: 5 },
    collapseIcon: { fontSize: 16 },
    mealNameContainer: { flex: 1, marginHorizontal: 10 },
    mealName: { fontWeight: '600', fontSize: 18 },
    placeholderText: { color: 'grey', fontWeight: 'normal' },
    deleteButton: { padding: 5 },
    settingsIcon: { fontSize: 20 },
    ingredientListContainer: { paddingTop: 10, borderTopWidth: 1, borderTopColor: '#eee', marginTop: 10 },
    mainContent: {
    },
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
        backgroundColor: '#e9e9e9',
        marginHorizontal: 2
    },
    dayButtonActive: {
        backgroundColor: primary,
    },
    dayText: {
        fontWeight: '600',
        color: '#888',
    },
    dayTextActive: {
        color: '#fff',
    },
    confirmationContainer: {
        alignItems: 'center',
        paddingVertical: 20,
    },
    confirmationTitle: {
        fontSize: 18,
        fontWeight: '600',
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
        borderColor: '#6c757d',
        backgroundColor: '#f8f9fa',
    },
    cancelButtonText: {
        color: '#6c757d',
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
    dragIcon: { fontSize: 18, color: '#aaa' },
    checkbox: { width: 24, height: 24, marginHorizontal: 10, borderWidth: 1, borderColor: '#ccc', borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
    editInput: { fontSize: 16, flex: 1, paddingVertical: 2 },
    checked: { textDecorationLine: 'line-through', color: '#999' },
    quantityChecked: { backgroundColor: '#eeeeee' },
    quantityTextChecked: { textDecorationLine: 'line-through', color: '#999' },
    clearButton: { paddingHorizontal: 8 },
    clearText: { fontSize: 16, color: '#999' },
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
        backgroundColor: '#eefff2ff',
        borderRadius: 12,
        marginRight: 8,
    },
    recipeIndicatorText: {
        marginLeft: 5,
        color: primary,
        fontWeight: '500',
        fontSize: 12,
    },
    quantityLabel: {
        backgroundColor: '#ebebebff',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 4,
        marginHorizontal: 3
    },
});

export default React.memo(MealCard);