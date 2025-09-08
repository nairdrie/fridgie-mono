import { Item } from "@/types/types";
import { primary } from "@/utils/styles";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useMemo, useState } from "react";
import { Keyboard, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

const UNITS = ['g', 'oz', 'ml', 'cups', 'tbsp'];
const CONVERSIONS: { [key: string]: { toBase: (v: number) => number; fromBase: (b: number) => number; unit: string, variations: RegExp } } = {
    g:    { toBase: v => v,          fromBase: b => b,          unit: 'g',    variations: /^g(rams?)?$/i },
    oz:   { toBase: v => v / 0.035274, fromBase: b => b * 0.035274, unit: 'oz',   variations: /^oz|ounces?$/i },
    ml:   { toBase: v => v,          fromBase: b => b,          unit: 'ml',   variations: /^ml|milliliters?$/i },
    cups: { toBase: v => v * 236.59, fromBase: b => b / 236.59, unit: 'cups', variations: /^cups?|c$/i },
    tbsp: { toBase: v => v * 14.79,  fromBase: b => b / 14.79,  unit: 'tbsp', variations: /^tbsps?|tablespoons?$/i },
};

const parseForConversion = (text: string) => {
    const parseRegex = /^(\d*\.?\d+)\s*([a-zA-Z]+)$/;
    const match = text.trim().match(parseRegex);
    if (!match) return null;

    const value = parseFloat(match[1]);
    const unitStr = match[2];

    for (const unitKey in CONVERSIONS) {
        if (CONVERSIONS[unitKey].variations.test(unitStr)) {
            return { value, unit: unitKey };
        }
    }
    return null;
}

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
    const [anchor, setAnchor] = useState<{ value: number, unit: string } | null>(null);

    useEffect(() => {
        // Pre-fill the input with the current quantity when the modal opens
        if (item) {
            setQuantity(item.quantity || '');
            if(item.quantity) setAnchor(parseForConversion(item.quantity));
        }
    }, [item]);

    const convertibleInfo = useMemo(() => {
        const parseRegex = /^(\d*\.?\d+)\s*([a-zA-Z]+)$/;
        const match = quantity.trim().match(parseRegex);
        if (!match) return null;

        const value = parseFloat(match[1]);
        const unitStr = match[2];

        for (const unitKey in CONVERSIONS) {
            if (CONVERSIONS[unitKey].variations.test(unitStr)) {
                return { value, unit: unitKey };
            }
        }
        return null;
    }, [quantity]);

    const handleCycleUnits = () => {
        if (!anchor) return; // Can't convert if there's no valid anchor
        Keyboard.dismiss();

        // 1. Determine the currently displayed unit
        const currentlyDisplayedInfo = parseForConversion(quantity);
        if (!currentlyDisplayedInfo) return;

        // 2. Find the next unit in the cycle
        const currentIndex = UNITS.indexOf(currentlyDisplayedInfo.unit);
        const nextIndex = (currentIndex + 1) % UNITS.length;
        const nextUnit = UNITS[nextIndex];

        // 3. IMPORTANT: Convert from the original, precise anchor value
        const baseValue = CONVERSIONS[anchor.unit].toBase(anchor.value);
        const newValue = CONVERSIONS[nextUnit].fromBase(baseValue);
        
        // 4. Format and update the displayed quantity
        let formattedValue;
        if (newValue < 1) formattedValue = newValue.toFixed(2);
        else if (newValue < 10) formattedValue = newValue.toFixed(1);
        else formattedValue = newValue.toFixed(0);

        setQuantity(`${formattedValue} ${CONVERSIONS[nextUnit].unit}`);
    };
    
    // --- NEW: Handler for when the user types in the input ---
    const handleTextChange = (text: string) => {
        setQuantity(text);
        // When the user types, reset the anchor to this new value.
        // All future conversions will be based on what they just typed.
        setAnchor(parseForConversion(text));
    };

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
                    <View style={styles.inputContainer}>
                        <TextInput
                            style={styles.modalInput}
                            value={quantity}
                            onChangeText={handleTextChange}
                            placeholder="e.g., 200g or 1 cup"
                            autoFocus={true}
                            onSubmitEditing={handleSave}
                        />
                        <TouchableOpacity 
                            style={styles.cycleButton} 
                            onPress={handleCycleUnits}
                            disabled={!convertibleInfo}
                        >
                            <Ionicons
                                name="swap-horizontal-outline" 
                                size={24} 
                                color={convertibleInfo ? primary : '#ccc'} 
                            />
                        </TouchableOpacity>
                    </View>

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
    // --- NEW: Style for the input and button wrapper ---
    inputContainer: {
      height:50,
        flexDirection: 'row',
        alignItems: 'center',
        width: '100%',
        borderWidth: 1,
        borderColor: '#ccc',
        borderRadius: 8,
        marginHorizontal: 5
    },
    modalInput: {
        flex: 1, // Take up available space
        padding: 12,
        fontSize: 16,
        textAlign: 'center',
        borderWidth: 0, // Remove individual border
        marginHorizontal: 5
    },
    // --- NEW: Style for the cycle button ---
    cycleButton: {
        paddingHorizontal: 12,
        height: '100%',
        justifyContent: 'center',
        alignItems: 'center',
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
        marginRight: 5,
    },
    cancelButtonText: {
        color: '#333',
        fontWeight: '600',
    },
    saveButton: {
        backgroundColor: primary,
        marginLeft: 5
    },
    saveButtonText: {
        color: '#fff',
        fontWeight: '600',
    }
});