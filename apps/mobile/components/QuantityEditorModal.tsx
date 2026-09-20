import { GlassPressable as TouchableOpacity, GlassSurface, useGlassPreferences } from '@/components/ui/Glass';
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
import { Keyboard, KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, View } from "react-native";

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
    const { reduceMotion } = useGlassPreferences();
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
            animationType={reduceMotion ? "none" : "fade"}
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
                <GlassSurface style={styles.modalContent} intensity={85}>
                    <Text style={styles.modalTitle}>How much?</Text>
                    <Text style={styles.modalItemName}>{item?.text}</Text>
                    <View style={styles.inputContainer}>
                        <TextInput
                            style={styles.modalInput}
                            value={quantity}
                            onChangeText={handleTextChange}
                            placeholder="e.g., 200g or 1 1/2 cups"
                            placeholderTextColor="#8B988E"
                            autoFocus={true}
                            onSubmitEditing={handleSave}
                        />
                        <TouchableOpacity
                            style={styles.cycleButton}
                            onPress={handleCycleUnits}
                            disabled={!convertibleInfo}
                            accessibilityLabel="Convert to the next unit"
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
                </GlassSurface>
            </KeyboardAvoidingView>
        </Modal>
    );
}
const styles = StyleSheet.create({
    modalContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(23,63,53,0.24)' },
    modalContent: { width: '88%', maxWidth: 410, backgroundColor: 'rgba(245,245,239,0.9)', borderRadius: 30, padding: 26, alignItems: 'center' },
    modalTitle: { fontSize: 28, fontWeight: '700', letterSpacing: -0.9, color: '#173F35', marginBottom: 9 },
    modalItemName: { fontSize: 15, color: '#78857D', marginBottom: 24, textAlign: 'center' },
    inputContainer: { height: 58, flexDirection: 'row', alignItems: 'center', width: '100%', borderWidth: 1, borderColor: '#DFE7DA', backgroundColor: 'rgba(255,255,255,0.75)', borderRadius: 18 },
    modalInput: { flex: 1, padding: 15, fontSize: 17, color: '#173F35', textAlign: 'center', borderWidth: 0 },
    cycleButton: { paddingHorizontal: 16, height: '100%', justifyContent: 'center', alignItems: 'center' },
    modalButtons: { flexDirection: 'row', marginTop: 24, width: '100%', gap: 10 },
    modalButton: { flex: 1, padding: 16, borderRadius: 18, alignItems: 'center' },
    cancelButton: { backgroundColor: '#E6EBE4' },
    cancelButtonText: { color: '#476458', fontWeight: '600', fontSize: 15 },
    saveButton: { backgroundColor: primary },
    saveButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 }
});
