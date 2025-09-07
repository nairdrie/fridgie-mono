// components/GroceryListView.tsx
import { Item } from '@/types/types';
import * as Haptics from 'expo-haptics';
import { LexoRank } from 'lexorank';
import React, { useCallback, useEffect, useState } from 'react';
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

interface QuantityEditorModalProps {
  isVisible: boolean;
  item: Item | null;
  onSave: (newQuantity: string) => void;
  onClose: () => void;
}

function QuantityEditorModal({ isVisible, item, onSave, onClose }: QuantityEditorModalProps) {
  const [quantity, setQuantity] = useState('');

  useEffect(() => {
    // Pre-fill the input with the current quantity when the modal opens
    if (item) {
      setQuantity(item.quantity || '');
    }
  }, [item]);

  const handleSave = () => {
    onSave(quantity);
  };

  return (
    <Modal
      transparent={true}
      visible={isVisible}
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.modalContainer}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>Edit Quantity</Text>
          <Text style={styles.modalItemName}>{item?.text}</Text>
          <TextInput
            style={styles.modalInput}
            value={quantity}
            onChangeText={setQuantity}
            placeholder="e.g., 200g or 1 cup"
            autoFocus={true}
            onSubmitEditing={handleSave}
          />
          <View style={styles.modalButtons}>
            <TouchableOpacity style={[styles.modalButton, styles.cancelButton]} onPress={onClose}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modalButton, styles.saveButton]} onPress={handleSave}>
              <Text style={styles.saveButtonText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

interface GroceryListViewProps {
  items: Item[];
  setItems: React.Dispatch<React.SetStateAction<Item[]>>;
  editingId: string;
  setEditingId: React.Dispatch<React.SetStateAction<string>>;
  inputRefs: React.MutableRefObject<Record<string, TextInput | null>>;
  isKeyboardVisible: boolean;
  markDirty: () => void;
}

export default function GroceryListView({
  items,
  setItems,
  editingId,
  setEditingId,
  inputRefs,
  isKeyboardVisible,
  markDirty,
}: GroceryListViewProps) {

  const [isModalVisible, setIsModalVisible] = useState(false);
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);

  
  const assignRef = useCallback((id: string) => (ref: TextInput | null) => {
    inputRefs.current[id] = ref;
  }, [inputRefs]);

  const updateItemText = (id: string, text: string) => {
    setItems(prev => prev.map(item => (item.id === id ? { ...item, text } : item)));
    markDirty();
  };

  const toggleCheck = (id: string) => {
    setItems(prev => prev.map(item => (item.id === id ? { ...item, checked: !item.checked } : item)));
    markDirty();
  };

  const addItemAfter = (id: string) => {
    const index = items.findIndex(i => i.id === id);
    if (index === -1) return;
    
    const current = LexoRank.parse(items[index].listOrder);
    const next = items[index + 1] ? LexoRank.parse(items[index + 1].listOrder) : current.genNext();
    const newItem: Item = { id: uuid.v4() as string, text: '', checked: false, listOrder: current.between(next).toString(), isSection: false };
    
    const updated = [...items];
    updated.splice(index + 1, 0, newItem);
    setItems(updated);
    setEditingId(newItem.id);
    markDirty();
    setTimeout(() => inputRefs.current[newItem.id]?.focus(), 50);
  };
  
  const deleteItem = (id: string) => {
    const index = items.findIndex(i => i.id === id);
    if (index === -1) return;

    if (items.length === 1) {
      const placeholderItem = {
        id: uuid.v4() as string,
        text: '',
        checked: false,
        listOrder: LexoRank.middle().toString(),
        isSection: false,
      };
      setItems([placeholderItem]);
      setEditingId(placeholderItem.id);
      markDirty();
      return;
    }

    delete inputRefs.current[id];
    const updated = items.filter(item => item.id !== id);
    setItems(updated);
    markDirty();

    if (isKeyboardVisible) {
      const nextFocusId = updated[Math.max(0, index - 1)]?.id;
      if (nextFocusId) {
        setEditingId(nextFocusId);
      }
    } else {
      setEditingId('');
    }
  };

  const reRankItems = (data: Item[]) => {
      let rank = LexoRank.middle();
      const newItems = data.map(item => {
          rank = rank.genNext();
          return { ...item, listOrder: rank.toString() };
      });
      setItems(newItems);
      markDirty();
  };
  
  const openQuantityEditor = (item: Item) => {
    setSelectedItem(item);
    setIsModalVisible(true);
  };

  const closeQuantityEditor = () => {
    setIsModalVisible(false);
    setSelectedItem(null);
  };

  const handleSaveQuantity = (newQuantity: string) => {
    if (!selectedItem) return;
    if(selectedItem.quantity === newQuantity) {
      closeQuantityEditor();
      return;
    }

    setItems(prev =>
      prev.map(i =>
        i.id === selectedItem.id
          // If the input is empty, set quantity to null, otherwise save the trimmed value
          ? { ...i, quantity: newQuantity.trim() || undefined }
          : i
      )
    );
    markDirty();
    closeQuantityEditor();
  };

  /**
 * Parses a string to find a quantity at the beginning OR end.
 * @param text The full item text.
 * @returns An object with the parsed quantity and the remaining text.
 */
const parseQuantityAndText = (text: string): { quantity: string | null; text: string } => {
  if (!text) return { quantity: null, text: '' };
  const trimmedText = text.trim();

  // 1. Check for quantity at the START (e.g., "2 eggs")
  // Regex: number, optional unit, then the rest of the text
  const startRegex = /^(\d*\.?\d+)\s*([a-zA-Z]*)\s+(.*)/;
  const startMatch = trimmedText.match(startRegex);

  if (startMatch) {
    const number = startMatch[1];
    const unit = startMatch[2];
    const remainingText = startMatch[3];
    return {
      quantity: `${number}${unit}`.trim(),
      text: remainingText,
    };
  }

  // 2. If no match at the start, check for quantity at the END (e.g., "eggs 2")
  // Regex: the text, then a space, then the number and optional unit
  const endRegex = /^(.*?)\s+(\d*\.?\d+\s*[a-zA-Z]*)$/;
  const endMatch = trimmedText.match(endRegex);
  
  if (endMatch) {
    const leadingText = endMatch[1];
    const quantity = endMatch[2];
    
    // Edge case: Avoid misinterpreting years as quantities (e.g., "Wine Vintage 2020")
    if (leadingText.toLowerCase().includes('vintage') && /^\d{4}$/.test(quantity.trim())) {
        return { quantity: null, text: trimmedText };
    }

    return {
      quantity: quantity.trim(),
      text: leadingText,
    };
  }

  // 3. No match found, return original text
  return { quantity: null, text: trimmedText };
};

  const handleItemBlur = (item: Item) => {
    // We only parse if there's no quantity already, or if the text has changed.
    const { quantity, text: newText } = parseQuantityAndText(item.text);
    
    // Only update if the parsing resulted in a change
    if (quantity || newText !== item.text) {
        setItems(prev =>
            prev.map(i =>
                i.id === item.id
                    ? { ...i, text: newText, quantity: quantity || i.quantity }
                    : i
            )
        );
        markDirty();
    }
    
    // Clear editing state when the user taps away
    setEditingId('');
  };


  const renderItem = useCallback(({ item, drag, isActive }: RenderItemParams<Item>) => {
    const isEditing = item.id === editingId;
    return (
      <View style={styles.itemRow}>
        <Pressable
          onLongPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            drag();
          }}
          disabled={isActive}
          style={styles.dragHandle}
          hitSlop={20}
        >
          <Text style={styles.dragIcon}>≡</Text>
        </Pressable>
        {!item.isSection && (
          <TouchableOpacity style={styles.checkbox} onPress={() => toggleCheck(item.id)}>
            {item.checked ? <Text>✓</Text> : null}
          </TouchableOpacity>
        )}
        { item.quantity && (
          <TouchableOpacity onPress={() => openQuantityEditor(item)}>
            <View style={styles.quantityLabel}>
              <Text>{item.quantity}</Text>
            </View>
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
            onBlur={() => handleItemBlur(item)}
            blurOnSubmit={false}
            returnKeyType="done"
        />
        {isEditing ? (
          <TouchableOpacity onPress={() => deleteItem(item.id)} style={styles.clearButton}>
            <Text style={styles.clearText}>✕</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.clearButton}>
            <Text style={styles.clearText}></Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }, [editingId, items, assignRef]);

  return (
    <>
      <DraggableFlatList
        data={items}
        onDragEnd={({ data }) => reRankItems(data)}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        windowSize={10}
        ListEmptyComponent={(
          <View style={styles.emptyListComponent}>
            <Text style={styles.emptyListText}>Your list is empty.</Text>
            <Text style={styles.emptyListSubText}>Tap the '+' to add an item.</Text>
          </View>
        )}
      />
      <QuantityEditorModal
          isVisible={isModalVisible}
          item={selectedItem}
          onSave={handleSaveQuantity}
          onClose={closeQuantityEditor}
      />
    </>
  );
}

const styles = StyleSheet.create({
  itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5 },
  dragHandle: { paddingHorizontal: 15, paddingVertical: 5 },
  dragIcon: { fontSize: 18, color: '#ccc' },
  checkbox: { width: 24, height: 24, marginRight: 10, borderWidth: 1, borderColor: '#999', alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  editInput: { fontSize: 16, flex: 1, paddingVertical: 0 },
  checked: { textDecorationLine: 'line-through', color: '#999' },
  clearButton: { paddingHorizontal: 8, paddingVertical: 4 },
  clearText: { fontSize: 16, color: '#999' },
  sectionText: { fontWeight: 'bold', fontSize: 18 },
  emptyListComponent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 100,
  },
  emptyListText: {
    fontSize: 18,
    color: '#888',
    fontWeight: '600'
  },
  emptyListSubText: {
    fontSize: 14,
    color: '#aaa',
    marginTop: 8,
  },
  quantityLabel: {
    backgroundColor: '#ebebebff',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginHorizontal: 3
  },
  modalContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalContent: {
    width: '85%',
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  modalItemName: {
    fontSize: 16,
    color: '#666',
    marginBottom: 16,
  },
  modalInput: {
    width: '100%',
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    textAlign: 'center',
  },
  modalButtons: {
    flexDirection: 'row',
    marginTop: 20,
    width: '100%',
  },
  modalButton: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelButton: {
    backgroundColor: '#f0f0f0',
    marginRight: 10,
  },
  cancelButtonText: {
    color: '#333',
    fontWeight: '600',
  },
  saveButton: {
    backgroundColor: '#00715a', // Using your primary color
  },
  saveButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
});