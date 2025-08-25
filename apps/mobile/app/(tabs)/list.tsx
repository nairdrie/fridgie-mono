import MealPlanView from '@/components/MealPlanView';
import { useLists } from '@/context/ListContext';
import { Item, List, ListView, Meal } from '@/types/types';
import { LexoRank } from 'lexorank';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import uuid from 'react-native-uuid';
import { categorizeList, createMeal, listenToList, updateList } from '../../utils/api';


export default function ListScreen() {
  const { selectedList, isLoading, groupId, selectedView } = useLists();
  
  const [meals, setMeals] = useState<Meal[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const [editingId, setEditingId] = useState<string>('');
  const [isCategorizing, setIsCategorizing] = useState(false);
  const [dirtyUntil, setDirtyUntil] = useState<number>(0);
  const inputRefs = useRef<Record<string, TextInput | null>>({});

  const dirtyUntilRef = useRef<number>(0);
  const markDirty = () => {
    const until = Date.now() + 1200; // tweak if you want a longer freeze
    dirtyUntilRef.current = until;
    setDirtyUntil(until); // keep your state if you read it elsewhere (optional)
  };

  // EFFECT 1: Handles ALL incoming data (Initial Fetch + Real-time Updates)
  useEffect(() => {
    if (!selectedList || !groupId) {
      setItems([]);
      setMeals([]);
      return;
    }

    const unsubscribe = listenToList(groupId, selectedList.id, (list: List) => {
      // ignore server echoes while the user is actively typing
      if (Date.now() < dirtyUntilRef.current) return;

      const rawItems = Array.isArray(list.items) ? list.items : [];
      const withOrder = rawItems
        .map((item: Item) => ({ ...item, order: item.order ?? LexoRank.middle().toString() }))
        .sort((a: Item, b: Item) => a.order.localeCompare(b.order));

      // optional: avoid pointless state updates (prevents cursor weirdness)
      setItems(prev => {
        const sameLength = prev.length === withOrder.length;
        const sameAll = sameLength && prev.every((p, i) =>
          p.id === withOrder[i].id &&
          p.text === withOrder[i].text &&
          p.checked === withOrder[i].checked &&
          p.order === withOrder[i].order &&
          p.isSection === withOrder[i].isSection
        );
        if (sameAll) return prev;

        if (withOrder.length === 0) {
          return [{
            id: uuid.v4() as string,
            text: '',
            checked: false,
            order: LexoRank.middle().toString(),
            isSection: false,
          }];
        }
        return withOrder;
      });

      setMeals(Array.isArray(list.meals) ? list.meals : []);
    });

    return () => unsubscribe();
  }, [selectedList, groupId]); // note: no need to depend on dirtyUntil now

  // EFFECT 2: Handles ALL outgoing data (Debounced Saving)
  useEffect(() => {
    if (!selectedList?.id || !groupId) return;
    const timeout = setTimeout(() => {
      const itemsToSave = items.filter(item => item.text !== '');
      updateList(groupId, selectedList.id, { items: itemsToSave, meals: meals }).catch(console.error);
    }, 500);
    return () => clearTimeout(timeout);
  }, [items, meals, selectedList?.id, groupId]);

  // whenever editingId (or items) changes, ensure focus
  useEffect(() => {
    if (!editingId) return;
    // next tick so the newly-rendered TextInput is mounted
    requestAnimationFrame(() => focusAtEnd(editingId));
  }, [editingId, items]);


  const assignRef = useCallback((id: string) => (ref: TextInput | null) => { inputRefs.current[id] = ref; }, []);
  const updateItemText = (id: string, text: string) => { setItems(prev => prev.map(item => (item.id === id ? { ...item, text } : item))); markDirty(); };
  const toggleCheck = (id: string) => { setItems(prev => prev.map(item => (item.id === id ? { ...item, checked: !item.checked } : item))); markDirty(); };

  const focusAtEnd = (id: string) => {
    const ref = inputRefs.current[id];
    if (!ref) return;
    ref.focus?.();

    // place caret at end (RN quirk: do it on a tick)
    const len = (items.find(i => i.id === id)?.text || '').length;
    setTimeout(() => {
      // @ts-ignore - setNativeProps selection is supported on RN TextInput
      ref.setNativeProps?.({ selection: { start: len, end: len } });
    }, 0);
  };

  const handleAddMeal = async (day: Meal['dayOfWeek']) => {
    if (!groupId || !selectedList) return;
    try {
      const newMeal = await createMeal(groupId, selectedList.id, day);
      setMeals(prev => [...prev, newMeal]);
      markDirty();
    } catch (err) {
      console.error("Failed to create meal", err);
    }
  };

   const addItemAfter = (id: string) => {
    // This function now only runs if there is already a selected list.
    if (!selectedList) return;
    
    const index = items.findIndex(i => i.id === id);
    if (index === -1) return;
    const current = LexoRank.parse(items[index].order);
    const next = items[index + 1] ? LexoRank.parse(items[index + 1].order) : current.genNext();
    const newItem: Item = { id: uuid.v4() as string, text: '', checked: false, order: current.between(next).toString(), isSection: false };
    
    const updated = [...items];
    updated.splice(index + 1, 0, newItem);
    setItems(updated);
    setEditingId(newItem.id);
    markDirty();
    setTimeout(() => inputRefs.current[newItem.id]?.focus(), 50);
  };

  const reRankItems = (data: Item[]) => {
    let rank = LexoRank.middle();
    return data.map(item => { rank = rank.genNext(); return { ...item, order: rank.toString() }; });
  };

  const deleteItem = (id: string) => {
    // if we’re at a single empty row, replace with placeholder like before
    if (items.length === 1) {
      const placeholderItem = {
        id: uuid.v4() as string,
        text: '',
        checked: false,
        order: LexoRank.middle().toString(),
        isSection: false,
      };
      setItems([placeholderItem]);
      setEditingId(placeholderItem.id);
      markDirty();
      return;
    }

    const index = items.findIndex(i => i.id === id);
    if (index === -1) return;

    // remove ref for the deleted row
    delete inputRefs.current[id];

    const updated = items.filter(item => item.id !== id);
    setItems(updated);
    markDirty();

    // focus previous item if possible, else the new first row
    const nextFocusId = updated[Math.max(0, index - 1)]?.id;
    if (nextFocusId) setEditingId(nextFocusId);
  };

  const handleAutoCategorize = async () => {
    if (!groupId || !selectedList?.id) return;
    setIsCategorizing(true);
    markDirty();
    try {
      const newItems = await categorizeList(groupId, selectedList.id);
      setItems(newItems);
      setEditingId('');
    } catch (err) {
      console.error('Auto-categorization failed', err);
    } finally {
      setIsCategorizing(false);
    }
  };

  const handleAddItem = () => {
    // This function now only runs if there is already a selected list.
    if (!selectedList) return;

    const lastOrder = items.length > 0 && items[items.length - 1].text !== '' ? LexoRank.parse(items[items.length - 1].order) : LexoRank.middle();
    const newItem: Item = { id: uuid.v4() as string, text: '', checked: false, order: lastOrder.genNext().toString(), isSection: false };
    const newItems = items.length === 1 && items[0].text === '' ? [newItem] : [...items, newItem];
    setItems(newItems);
    setEditingId(newItem.id);
    markDirty();
    setTimeout(() => inputRefs.current[newItem.id]?.focus(), 50);
  };

  const handleAddIngredientToMeal = (meal: Meal, ingredientText: string) => {
    if (!ingredientText) return;

    // 1. Create a new Item object, linking it to the meal
    const newItem: Item = {
      id: uuid.v4() as string,
      text: ingredientText,
      checked: false,
      order: LexoRank.middle().toString(), // You'll want better ranking logic
      isSection: false,
      mealId: meal.id, // ✅ Link it!
    };

    // 2. Add the new item to the single source of truth
    setItems(prevItems => [...prevItems, newItem]);

    markDirty(); // To trigger the debounced save
  };

  const renderItem = ({ item, drag }: RenderItemParams<Item>) => {
    const isEditing = item.id === editingId;
    return (
      <View style={styles.itemRow}>
        <Pressable onPressIn={drag} style={styles.dragHandle} hitSlop={10}>
          <Text style={styles.dragIcon}>≡</Text>
        </Pressable>
        {!item.isSection && (
          <TouchableOpacity style={styles.checkbox} onPress={() => toggleCheck(item.id)}>
            {item.checked ? <Text>✓</Text> : null}
          </TouchableOpacity>
        )}
        <TextInput
          ref={assignRef(item.id)}
          value={item.text}
          style={[styles.editInput, item.checked && styles.checked, item.isSection && styles.sectionText]}
          onChangeText={text => updateItemText(item.id, text)}
          onFocus={() => setEditingId(item.id)}
          onKeyPress={({ nativeEvent }) => {
            if (nativeEvent.key === 'Backspace' && item.text === '') {
              deleteItem(item.id);
            }
          }}
          onSubmitEditing={() => addItemAfter(item.id)}
          blurOnSubmit={false}
          returnKeyType="done"
        />
        {isEditing && (
          <TouchableOpacity onPress={() => deleteItem(item.id)} style={styles.clearButton}>
            <Text style={styles.clearText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };
  
  if (isLoading) {
    return <View style={styles.container}><ActivityIndicator /></View>;
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#fff' }}>
      {/* MAIN BODY */}
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={100}
      >
        { selectedView == ListView.GroceryList ? (
          <DraggableFlatList
            data={items}
            onDragEnd={({ data }) => { setItems(reRankItems(data)); markDirty(); }}
            keyExtractor={item => item.id}
            renderItem={renderItem}
            keyboardDismissMode="interactive"
          />
        ) : (
          <MealPlanView
            meals={meals}
            items={items} // ✅ Pass down all items
            onAddMeal={handleAddMeal}
            onAddIngredient={handleAddIngredientToMeal} // Pass the handler
          />
        )}
      </KeyboardAvoidingView>

      {/* BUTTON ROW */}
      <View style={styles.buttonRow}>
        <TouchableOpacity style={styles.actionButton} onPress={handleAddItem}>
          <Text style={styles.buttonText}>+ Item</Text>
        </TouchableOpacity>
        {selectedView == ListView.GroceryList && 
          <>
            <TouchableOpacity style={styles.actionButton}>
              <Text style={styles.buttonText}>+ Section</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, isCategorizing && { opacity: 0.5 }]}
              onPress={handleAutoCategorize}
              disabled={isCategorizing || !selectedList}
            >
              <Text style={styles.buttonText}>{isCategorizing ? 'Categorizing…' : 'Auto-Categorize'}</Text>
            </TouchableOpacity>
          </>
        }
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', padding: 10 },
  itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  dragHandle: { width: 40, alignItems: 'center', justifyContent: 'center' },
  dragIcon: { fontSize: 18 },
  checkbox: { width: 24, height: 24, marginHorizontal: 10, borderWidth: 1, borderColor: '#999', alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  editInput: { fontSize: 16, flex: 1, paddingVertical: 0, borderWidth: 0, borderColor: 'transparent' },
  checked: { textDecorationLine: 'line-through', color: '#999' },
  clearButton: { paddingHorizontal: 8, paddingVertical: 4 },
  clearText: { fontSize: 16, color: '#999' },
  sectionText: { fontWeight: 'bold', fontSize: 16 },
  buttonRow: { flexDirection: 'row', justifyContent: 'flex-start', gap: 8, padding: 16, borderTopWidth: 1, borderColor: '#eee', backgroundColor: '#fff' },
  actionButton: { paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: '#ccc', borderRadius: 4 },
  buttonText: { fontSize: 14, color: '#444' },
});