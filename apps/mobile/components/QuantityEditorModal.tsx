import { Item } from "@/types/types";
import { primary } from "@/utils/styles";
import { useEffect, useState } from "react";
import { Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

interface QuantityEditorModalProps {
    isVisible: boolean;
    item: Item | null;
    onSave: (newQuantity: string) => void;
    onClose: () => void;
}

  /**
 * Parses a string to find a quantity at the beginning OR end.
 * @param text The full item text.
 * @returns An object with the parsed quantity and the remaining text.
 */
export const parseQuantityAndText = (text: string): { quantity: string | null; text: string } => {
  if (!text) return { quantity: null, text: '' };
  const trimmedText = text.trim();

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

export default function QuantityEditorModal({ isVisible, item, onSave, onClose }: QuantityEditorModalProps) {
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
 const styles = StyleSheet.create({
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
    backgroundColor: primary, // Using your primary color
  },
  saveButtonText: {
    color: '#fff',
    fontWeight: '600',
  }
});