// components/QuantityEditorModal.tsx
import { Item } from "@/types/types";
import {
    convert,
    formatQuantity,
    parseQuantity,
    unitCycle,
} from "@/utils/quantity";
import { primary } from "@/utils/styles";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useMemo, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

// Re-exported for existing imports; implementation lives in utils/quantity.
export { parseQuantityAndText } from "@/utils/quantity";

const parseForConversion = (text: string) => {
    const parsed = parseQuantity(text);
    if (!parsed || !parsed.known || !parsed.unit) return null;
    return { value: parsed.value, unit: parsed.unit };
};

interface QuantityEditorModalProps {
    isVisible: boolean;
    item: (Item & { totalQuantity?: string }) | null;
    onSave: (newQuantity: string) => void;
    onClose: () => void;
}

export default function QuantityEditorModal({ isVisible, item, onSave, onClose }: QuantityEditorModalProps) {
    const [quantity, setQuantity] = useState('');
    // The last user-entered convertible quantity; unit cycling always converts
    // from this anchor so repeated cycles don't accumulate rounding error.
    const [anchor, setAnchor] = useState<{ value: number, unit: string } | null>(null);

    useEffect(() => {
        if (item) {
            const initialQuantity = item.totalQuantity || item.quantity || '';
            setQuantity(initialQuantity);
            setAnchor(parseForConversion(initialQuantity));
        }
    }, [item]);

    const convertibleInfo = useMemo(() => parseForConversion(quantity), [quantity]);

    const handleCycleUnits = () => {
        if (!anchor) return;
        Keyboard.dismiss();

        const current = parseForConversion(quantity);
        if (!current) return;

        // Only cycle through units of the same dimension (mass stays mass,
        // volume stays volume) — there is no safe density assumption.
        const cycle = unitCycle(current.unit);
        if (cycle.length < 2) return;

        const nextUnit = cycle[(cycle.indexOf(current.unit) + 1) % cycle.length];
        const newValue = convert(anchor.value, anchor.unit, nextUnit);
        if (newValue === null) return;

        setQuantity(formatQuantity(newValue, nextUnit));
    };

    const handleTextChange = (text: string) => {
        setQuantity(text);
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
            {/* The input autofocuses, so the keyboard is already up by the time
                this is on screen. Centred in the full screen that put the Save
                and Cancel buttons — and on a shorter phone the input itself —
                underneath it. */}
            <KeyboardAvoidingView
                style={styles.modalContainer}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <View style={styles.modalContent}>
                    <Text style={styles.modalTitle}>Edit Quantity</Text>
                    <Text style={styles.modalItemName}>{item?.text}</Text>
                    <View style={styles.inputContainer}>
                        <TextInput
                            style={styles.modalInput}
                            value={quantity}
                            onChangeText={handleTextChange}
                            placeholder="e.g., 200g or 1 1/2 cups"
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
            </KeyboardAvoidingView>
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
        flex: 1,
        padding: 12,
        fontSize: 16,
        textAlign: 'center',
        borderWidth: 0,
        marginHorizontal: 5
    },
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
