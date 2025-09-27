// components/GroceryListView.tsx

// TODO: if I have 200g sugar in list, 2 tsp sugar in a meal, the quantity is updated to "200 g + 2 tsp". Convert tsp to the unit in main list.
import { Item, List } from '@/types/types';
import { primary } from '@/utils/styles';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LexoRank } from 'lexorank';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import uuid from 'react-native-uuid';
import QuantityEditorModal, { parseQuantityAndText } from './QuantityEditorModal';

type AggregatedItem = Item & {
 sourceIds: string[];
 totalQuantity: string;
};

// --- HELPER FUNCTIONS ---
const parseNumericQuantity = (q?: string): { value: number; unit: string } | null => {
 if (!q) return null;
 const match = q.trim().match(/^(\d*\.?\d+)\s*(.*)$/);
 if (!match) return null;
 return { value: parseFloat(match[1]), unit: match[2].trim() };
};

// --- COMPONENT PROPS ---
interface GroceryListViewProps {
  items: Item[];
  setItems: React.Dispatch<React.SetStateAction<Item[]>>;
  editingId: string;
  setEditingId: React.Dispatch<React.SetStateAction<string>>;
  inputRefs: React.MutableRefObject<Record<string, TextInput | null>>;
  isKeyboardVisible: boolean;
  markDirty: () => void;
  sort?: List['sort'];
  setSort: (sort: List['sort']) => void;
  onCategorize: () => Promise<void>;
}

export default function GroceryListView({
  items,
  setItems,
  editingId,
  setEditingId,
  inputRefs,
  isKeyboardVisible,
  markDirty,
  sort = 'custom',
  setSort,
  onCategorize
}: GroceryListViewProps) {
 const [isModalVisible, setIsModalVisible] = useState(false);
 const [selectedItem, setSelectedItem] = useState<AggregatedItem | null>(null);

 const [isSortModalVisible, setIsSortModalVisible] = useState(false);

 const aggregatedItems = useMemo((): (AggregatedItem | Item)[] => {
        const itemMap = new Map<string, Item[]>();
        const sections: Item[] = [];

        for (const item of items) {
            if (item.isSection) {
                sections.push(item);
                continue;
            }
            const key = item.text.trim().toLowerCase() || `__blank-${item.id}__`;
            if (!itemMap.has(key)) {
                itemMap.set(key, []);
            }
            itemMap.get(key)!.push(item);
        }

        const result: AggregatedItem[] = [];
        for (const [, sources] of itemMap) {
            if (sources.length === 0) continue;
            const baseItem = sources[0];
            const overrideSource = sources.find(s => s.overrideQuantity);
            let totalQuantity = '';

            if (overrideSource && overrideSource.overrideQuantity) {
                totalQuantity = overrideSource.overrideQuantity;
            } else {
                const quantities = sources.map(s => parseNumericQuantity(s.quantity)).filter(Boolean) as { value: number; unit: string }[];
                if (quantities.length > 0) {
                    const unitTotals = quantities.reduce((acc, q) => {
                        const unitKey = q.unit.toLowerCase() || 'misc';
                        acc[unitKey] = (acc[unitKey] || 0) + q.value;
                        return acc;
                    }, {} as Record<string, number>);

                    totalQuantity = Object.entries(unitTotals)
                        .map(([unit, value]) => `${parseFloat(value.toFixed(2))}${unit === 'misc' ? '' : ` ${unit}`}`)
                        .join(' + ');
                }
            }

            result.push({
                ...baseItem,
                id: `agg-${sources.map(s => s.id).sort().join('-')}`,
                sourceIds: sources.map(s => s.id),
                totalQuantity,
                checked: sources.every(s => s.checked),
            });
        }
        
        const combined = [...result, ...sections];
        combined.sort((a, b) => a.listOrder.localeCompare(b.listOrder));
        return combined;
    }, [items]);

  const handleSelectSort = (selectedMode: List['sort']) => {
        if (selectedMode === 'category') {
            onCategorize();
        } else if (selectedMode === 'alphabetical') {
            const newRankedItems = reRankAlphabetically(items);
            setItems(newRankedItems);
            setSort('custom'); // Immediately set the mode to custom, locking in the new order.
        } else {
            // This case handles selecting "Custom" which does nothing but close the modal.
            setSort('custom');
        }
        setIsSortModalVisible(false);
    };

    const reRankAlphabetically = (currentItems: Item[]) => {
        const itemsWithoutSections = currentItems.filter(item => !item.isSection);
        const sortedAlphabetically = [...itemsWithoutSections].sort((a, b) => a.text.localeCompare(b.text));
        
        let rank = LexoRank.middle();
        const rankMap = new Map<string, string>();
        sortedAlphabetically.forEach(item => {
            rank = rank.genNext();
            rankMap.set(item.id, rank.toString());
        });

        return currentItems
            .filter(item => !item.isSection) // ensure sections are removed
            .map(item => ({
                ...item,
                listOrder: rankMap.get(item.id) || item.listOrder
            }));
    };

    
    // ✅ Gets the correct icon and text for the current sort mode
    const getSortIcon = () => {
        switch (sort) {
            case 'alphabetical': return { icon: "text-outline", text: "Alpha" };
            case 'category': return { icon: "sparkles-outline", text: "Category" };
            default: return { icon: "swap-vertical-outline", text: "Custom" };
        }
    };

    const { icon, text: sortText } = getSortIcon();

 const assignRef = useCallback((id: string) => (ref: TextInput | null) => {
   inputRefs.current[id] = ref;
 }, [inputRefs]);

 const updateItemText = (id: string, text: string) => {
   setItems(prev => prev.map(item => (item.id === id ? { ...item, text } : item)));
   markDirty();
 };

 const toggleCheck = (aggItem: AggregatedItem) => {
   const newCheckedState = !aggItem.checked;
   setItems(prev => prev.map(item => aggItem.sourceIds.includes(item.id) ? { ...item, checked: newCheckedState } : item));
   markDirty();
 };

 const addItemAfter = (currentItem?: AggregatedItem | Item) => {
        if (!currentItem) {
            const newItem: Item = { id: uuid.v4() as string, text: '', checked: false, listOrder: LexoRank.middle().toString(), isSection: false };
            setItems(prev => [...prev, newItem]);
            setEditingId(newItem.id);
            markDirty();
            return;
        }
        const currentIndex = aggregatedItems.findIndex(i => i.id === currentItem.id);
        if (currentIndex === -1) return;

        const currentRank = LexoRank.parse(aggregatedItems[currentIndex].listOrder);
        const nextItem = aggregatedItems[currentIndex + 1];
        const nextRank = nextItem ? LexoRank.parse(nextItem.listOrder) : currentRank.genNext();
        const newItem: Item = { id: uuid.v4() as string, text: '', checked: false, listOrder: currentRank.between(nextRank).toString(), isSection: false };
        setItems(prev => [...prev, newItem]);
        setEditingId(newItem.id);
        markDirty();
    };

const deleteItem = (aggItem: AggregatedItem) => {
   const sourceIdsToDelete = new Set(aggItem.sourceIds);
   const updatedItems = items.filter(item => !sourceIdsToDelete.has(item.id));
   setItems(updatedItems);
   markDirty();
   if (isKeyboardVisible) {
  const currentIndex = aggregatedItems.findIndex(i => i.id === aggItem.id);
  const prevItem = aggregatedItems[Math.max(0, currentIndex - 1)];
     if (prevItem && prevItem.id !== aggItem.id && 'sourceIds' in prevItem) {
       setEditingId(prevItem.sourceIds[0]);
     } else {
       setEditingId('');
     }
   } else {
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
         prev.map(i =>
           i.id === baseItemId ? { ...i, text: newText, quantity: quantity || i.quantity } : i
         )
       );
       markDirty();
   }
   setEditingId('');
 };

 const reRankItems = (data: (AggregatedItem | Item)[]) => {
    setSort('custom');
     let rank = LexoRank.middle();
     const rankMap = new Map<string, string>();
     data.forEach(item => {
       rank = rank.genNext();
       if ('sourceIds' in item) {
         const baseItemId = item.sourceIds[0];
         rankMap.set(baseItemId, rank.toString());
         for (let i = 1; i < item.sourceIds.length; i++) {
           rankMap.set(item.sourceIds[i], rank.genNext().toString());
         }
       } else {
         rankMap.set(item.id, rank.toString());
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

 /**
  * [FIXED] Handles quantity changes, now with override logic for unit conflicts.
  */
 const handleSaveQuantity = (newQuantityStr: string) => {
    if (!selectedItem) return;
    const newQuant = newQuantityStr.trim();
    const desiredTotalParsed = parseNumericQuantity(newQuant);

    setItems(prev => {
        const mealItems = prev.filter(item =>
            selectedItem.sourceIds.includes(item.id) && !!item.mealId
        );
        let hasUnitConflict = false;
        if (desiredTotalParsed) {
            const desiredUnit = desiredTotalParsed.unit.toLowerCase() || 'misc';
            hasUnitConflict = mealItems.some(item => {
                const mealParsed = parseNumericQuantity(item.quantity);
                return mealParsed && (mealParsed.unit.toLowerCase() || 'misc') !== desiredUnit;
            });
        }

        let mainListItemId = prev.find(item =>
            selectedItem.sourceIds.includes(item.id) && !item.mealId
        )?.id;

        // --- BRANCH 1: OVERRIDE DUE TO UNIT CONFLICT ---
        if (hasUnitConflict) {
            if (mainListItemId) {
                // Update existing main item with an override, clearing its base quantity.
                return prev.map(item => item.id === mainListItemId ? { ...item, quantity: undefined, overrideQuantity: newQuant } : item);
            } else {
                // Create a new main item with an override.
                const lastItem = prev[prev.length - 1];
                const newRank = lastItem ? LexoRank.parse(lastItem.listOrder).genNext() : LexoRank.middle();
                const newItem: Item = {
                    id: uuid.v4() as string, text: selectedItem.text, checked: false, isSection: false,
                    listOrder: newRank.toString(), overrideQuantity: newQuant
                };
                return [...prev, newItem];
            }
        }
        
        // --- BRANCH 2: NORMAL CALCULATION (NO UNIT CONFLICT) ---
        let quantityToSet: string | undefined = undefined;
        let shouldRemoveMainItem = false;

        if (!newQuant) {
            shouldRemoveMainItem = true;
        } else if (desiredTotalParsed) {
            const desiredUnit = desiredTotalParsed.unit.toLowerCase() || 'misc';
            const mealContribution = mealItems.reduce((sum, item) => {
                const parsed = parseNumericQuantity(item.quantity);
                if (parsed && (parsed.unit.toLowerCase() || 'misc') === desiredUnit) {
                    return sum + parsed.value;
                }
                return sum;
            }, 0);
            const mainListQuantityNeeded = desiredTotalParsed.value - mealContribution;
            if (mainListQuantityNeeded <= 0) {
                shouldRemoveMainItem = true;
            } else {
                const originalUnit = desiredTotalParsed.unit;
                quantityToSet = `${parseFloat(mainListQuantityNeeded.toFixed(2))}${originalUnit ? ` ${originalUnit}` : ''}`;
            }
        } else {
            quantityToSet = newQuant;
        }

        if (mainListItemId) {
            if (shouldRemoveMainItem) {
                return prev.filter(item => item.id !== mainListItemId);
            }
            // Update existing main item, clearing any override.
            return prev.map(item => item.id === mainListItemId ? { ...item, quantity: quantityToSet, overrideQuantity: undefined } : item);
        } else if (!shouldRemoveMainItem) {
            // Create a new main item.
            const lastItem = prev[prev.length - 1];
            const newRank = lastItem ? LexoRank.parse(lastItem.listOrder).genNext() : LexoRank.middle();
            const newItem: Item = {
                id: uuid.v4() as string, text: selectedItem.text, checked: false, isSection: false,
                listOrder: newRank.toString(), quantity: quantityToSet
            };
            return [...prev, newItem];
        }

        return prev;
    });

    markDirty();
    closeQuantityEditor();
};

 const renderItem = useCallback(({ item, drag, isActive }: RenderItemParams<AggregatedItem | Item>) => {
   if (item.isSection) {
        const isEditing = editingId === item.id;
        return (
            <View style={styles.itemRow}>
                <Pressable onLongPress={drag} disabled={isActive} style={styles.dragHandle} hitSlop={20}>
                    <Text style={styles.dragIcon}>≡</Text>
                </Pressable>

                {/* Use a TextInput for sections */}
                <TextInput
                    ref={assignRef(item.id)}
                    value={item.text}
                    style={[styles.editInput, styles.sectionText]}
                    onChangeText={text => updateItemText(item.id, text)}
                    onFocus={() => setEditingId(item.id)}
                    onBlur={() => setEditingId('')}
                    onSubmitEditing={() => addItemAfter(item)}
                    onKeyPress={({ nativeEvent }) => {
                        if (nativeEvent.key === 'Backspace' && item.text === '') {
                            // Simple delete for sections
                            setItems(prev => prev.filter(i => i.id !== item.id));
                            markDirty();
                        }
                    }}
                    returnKeyType="next"
                    blurOnSubmit={false}
                />

                {isEditing && (
                    <TouchableOpacity
                        onPress={() => {
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
     <View style={styles.itemRow}>
       <Pressable onLongPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); drag(); }} disabled={isActive} style={styles.dragHandle} hitSlop={20}>
         <Text style={styles.dragIcon}>≡</Text>
       </Pressable>
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
           onChangeText={text => updateItemText(baseItemId, text)} onFocus={() => setEditingId(baseItemId)}
           onBlur={() => handleItemBlur(aggItem)} onSubmitEditing={() => addItemAfter(aggItem)}
           onKeyPress={({ nativeEvent }) => { if (nativeEvent.key === 'Backspace' && aggItem.text === '') { deleteItem(aggItem); } }}
           returnKeyType="next" blurOnSubmit={false}
       />
       
       {isEditing && (
           <TouchableOpacity onPress={() => deleteItem(aggItem)} style={styles.clearButton}>
               <Text style={styles.clearText}>✕</Text>
           </TouchableOpacity>
       )}
     </View>
   );
 }, [items, editingId, aggregatedItems]);

 return (
   <View style={{ flex: 1 }}>
    <View style={styles.headerContainer}>
                <TouchableOpacity style={styles.sortButton} onPress={() => setIsSortModalVisible(true)}>
                    <Ionicons name={'swap-vertical-outline'} size={20} color={primary} />
                    <Text style={styles.sortButtonText}>{sortText}</Text>
                </TouchableOpacity>
            </View>
    { aggregatedItems.length == 0 && 
         <View style={styles.emptyMealsContainer}>
           <Text style={styles.emptyMealsText}>Your list is empty</Text>
           <TouchableOpacity 
               style={styles.addMealButton}
               onPress={() => addItemAfter()}>
               <Text style={styles.addMealText}>+ Add Item</Text>
           </TouchableOpacity>
         </View>
      }
     <DraggableFlatList
       data={aggregatedItems} onDragEnd={({ data }) => reRankItems(data)}
       keyExtractor={item => item.id} renderItem={renderItem as any}
       keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled"
       initialNumToRender={20} maxToRenderPerBatch={10} windowSize={10}
     />
     <QuantityEditorModal
       isVisible={isModalVisible} item={selectedItem}
       onSave={handleSaveQuantity} onClose={closeQuantityEditor}
     />
     <Modal
        transparent={true}
        visible={isSortModalVisible}
        onRequestClose={() => setIsSortModalVisible(false)}
        animationType="fade"
    >
        <Pressable style={styles.modalOverlay} onPress={() => setIsSortModalVisible(false)}>
            <View style={styles.sortModalContent}>
                <Text style={styles.sortModalTitle}>Sort List By</Text>
                
                <TouchableOpacity style={styles.sortOption} onPress={() => handleSelectSort('custom')}>
                    <Ionicons name="swap-vertical-outline" size={24} color={primary} style={styles.sortIcon}/>
                    <Text style={styles.sortOptionText}>Custom</Text>
                    {sort === 'custom' && <Ionicons name="checkmark-circle" size={24} color="#4CAF50" />}
                </TouchableOpacity>

                <TouchableOpacity style={styles.sortOption} onPress={() => handleSelectSort('alphabetical')}>
                    <Ionicons name="text-outline" size={24} color={primary} style={styles.sortIcon}/>
                    <Text style={styles.sortOptionText}>Alphabetical</Text>
                    {sort === 'alphabetical' && <Ionicons name="checkmark-circle" size={24} color="#4CAF50" />}
                </TouchableOpacity>

                <TouchableOpacity style={styles.sortOption} onPress={() => handleSelectSort('category')}>
                    <Ionicons name="sparkles-outline" size={24} color={primary} style={styles.sortIcon}/>
                    <Text style={styles.sortOptionText}>By Category</Text>
                    {sort === 'category' && <Ionicons name="checkmark-circle" size={24} color="#4CAF50" />}
                </TouchableOpacity>
            </View>
        </Pressable>
    </Modal>
   </View>
 );
}

const styles = StyleSheet.create({
  headerContainer: {
        position: 'absolute',
        // top: -10,
        right: 10,
        zIndex: 10,
    },
    sortButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#fff',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 20,
        elevation: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
    },
    sortButtonText: {
        marginLeft: 6,
        color: primary,
        fontWeight: '600',
    },
     modalOverlay: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(0,0,0,0.4)',
    },
    sortModalContent: {
        backgroundColor: 'white',
        borderRadius: 12,
        padding: 20,
        width: '80%',
        elevation: 10,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 10,
    },
    sortModalTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        marginBottom: 20,
        textAlign: 'center',
        color: '#333',
    },
    sortOption: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 15,
    },
    sortIcon: {
        marginRight: 15,
    },
    sortOptionText: {
        fontSize: 16,
        flex: 1,
        color: '#333',
    },
 itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, minHeight: 36 },
 dragHandle: { paddingHorizontal: 15, paddingVertical: 5 },
 dragIcon: { fontSize: 18, color: '#ccc' },
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