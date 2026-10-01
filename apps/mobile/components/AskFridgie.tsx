// components/AskFridgie.tsx
//
// A chat about the recipe that is open underneath it — "can I use butter
// instead?", "how do I know it's done?", "make it dairy-free".
//
// Rendered INSIDE ViewRecipeModal as an overlay, for the same reason cook mode
// is: a second <Modal> presented from a screen that is already presenting the
// recipe sheet never appears on iOS.
//
// Fridgie can change the recipe, but never on its own. On a recipe the reader
// owns, an answer can carry a complete proposed version; it shows here as a
// card with Apply and No thanks, and only Apply saves anything. On somebody
// else's recipe the server never returns a proposal at all, and the header says
// why: make your own copy first.
import { GlassPressable, GlassSurface } from '@/components/ui/Glass';
import { Recipe } from '@/types/types';
import { ApiError, askFridgieAboutRecipe, type AskFridgieProposal, type AskFridgieTurn } from '@/utils/api';
import { accentSoft, canvas, hairline, ink, inkFaint, inkMuted, primary, surface } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    KeyboardAvoidingView,
    Platform,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type ProposalState = 'pending' | 'applying' | 'applied' | 'declined';

export interface AskMessage {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    proposal?: AskFridgieProposal | null;
    proposalState?: ProposalState;
    /** A failed request, shown in the thread but never sent back as history. */
    isError?: boolean;
}

interface AskFridgieProps {
    recipe: Recipe;
    messages: AskMessage[];
    setMessages: React.Dispatch<React.SetStateAction<AskMessage[]>>;
    /** The servings the reader has the stepper on, so "how much flour?" is answered for that. */
    viewingServings: number | null;
    /** Client-side guess at ownership, used only to pick the starter prompts. */
    isAuthor: boolean;
    onClose: () => void;
    /** Saves a proposal the reader accepted. Rejects if the save failed. */
    onApply: (proposal: AskFridgieProposal) => Promise<void>;
    /** The server said this account isn't Pro after all. */
    onRequirePro: () => void;
}

const MAX_MESSAGE_CHARS = 2000;

const STARTERS_OWN = [
    'What can I substitute for an ingredient?',
    'Make this dairy-free',
    'Can I make this ahead?',
];
const STARTERS_OTHERS = [
    'What can I substitute for an ingredient?',
    'What should I serve with this?',
    'How long do leftovers keep?',
];

let nextId = 0;
const messageId = () => `ask-${Date.now()}-${nextId++}`;

/**
 * What an earlier answer said, as history for the next turn. A proposal is
 * summarised with what the cook did about it, so "actually, use less" lands on
 * the version they kept.
 */
function toTurn(message: AskMessage): AskFridgieTurn {
    if (message.role === 'assistant' && message.proposal) {
        const outcome = message.proposalState === 'applied'
            ? 'they applied it, so the recipe now includes it'
            : message.proposalState === 'declined'
                ? 'they declined it, so the recipe is unchanged'
                : 'they have not decided yet';
        return { role: 'assistant', content: `${message.text}\n\n[Proposed edit: ${message.proposal.summary} — ${outcome}.]` };
    }
    return { role: message.role, content: message.text };
}

export default function AskFridgie({
    recipe,
    messages,
    setMessages,
    viewingServings,
    isAuthor,
    onClose,
    onApply,
    onRequirePro,
}: AskFridgieProps) {
    const insets = useSafeAreaInsets();
    const [input, setInput] = useState('');
    const [isSending, setIsSending] = useState(false);
    /** Last answer's verdict on ownership; null until the server has said. */
    const [canEdit, setCanEdit] = useState<boolean | null>(null);
    const listRef = useRef<FlatList<AskMessage>>(null);
    const abortRef = useRef<AbortController | null>(null);

    // Closing the chat mid-answer abandons the request rather than letting it
    // land in a thread nobody is looking at.
    useEffect(() => () => abortRef.current?.abort(), []);

    useEffect(() => {
        if (messages.length) {
            const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
            return () => clearTimeout(timer);
        }
    }, [messages.length, isSending]);

    const send = async (raw: string) => {
        const text = raw.trim().slice(0, MAX_MESSAGE_CHARS);
        if (!text || isSending) return;

        const question: AskMessage = { id: messageId(), role: 'user', text };
        const history = [...messages.filter((m) => !m.isError), question].map(toTurn);
        setMessages((prev) => [...prev, question]);
        setInput('');
        setIsSending(true);

        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const answer = await askFridgieAboutRecipe(recipe.id, history, viewingServings, controller.signal);
            if (controller.signal.aborted) return;
            setCanEdit(answer.canEdit);
            setMessages((prev) => [...prev, {
                id: messageId(),
                role: 'assistant',
                text: answer.reply,
                proposal: answer.proposal,
                proposalState: answer.proposal ? 'pending' : undefined,
            }]);
        } catch (error) {
            if (controller.signal.aborted) return;
            if (error instanceof ApiError && error.code === 'pro_required') {
                onRequirePro();
                return;
            }
            const message = error instanceof ApiError && error.status !== 0 && error.message
                ? error.message
                : 'Fridgie couldn’t answer just now. Check your connection and try again.';
            setMessages((prev) => [...prev, { id: messageId(), role: 'assistant', text: message, isError: true }]);
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setIsSending(false);
        }
    };

    const setProposalState = (id: string, state: ProposalState) =>
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, proposalState: state } : m)));

    const apply = async (message: AskMessage) => {
        if (!message.proposal || message.proposalState !== 'pending') return;
        setProposalState(message.id, 'applying');
        try {
            await onApply(message.proposal);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            // Any older proposal was written against the recipe before this
            // change; applying it now would quietly undo this one.
            setMessages((prev) => prev.map((m) => {
                if (m.id === message.id) return { ...m, proposalState: 'applied' };
                if (m.proposalState === 'pending') return { ...m, proposalState: 'declined' };
                return m;
            }));
        } catch {
            setProposalState(message.id, 'pending');
            setMessages((prev) => [...prev, {
                id: messageId(),
                role: 'assistant',
                text: 'I couldn’t save that change. Your recipe is unchanged — try Apply again in a moment.',
                isError: true,
            }]);
        }
    };

    const ownsRecipe = canEdit ?? isAuthor;
    const starters = ownsRecipe ? STARTERS_OWN : STARTERS_OTHERS;

    const renderProposal = (message: AskMessage) => {
        const proposal = message.proposal!;
        const state = message.proposalState ?? 'pending';
        return (
            <View style={styles.proposalCard}>
                <View style={styles.proposalHeader}>
                    <Ionicons name="create-outline" size={16} color={primary} />
                    <Text style={styles.proposalTitle}>Suggested change</Text>
                </View>
                <Text style={styles.proposalSummary}>{proposal.summary}</Text>
                {state === 'applied' ? (
                    <View style={styles.proposalOutcome}>
                        <Ionicons name="checkmark-circle" size={16} color={primary} />
                        <Text style={styles.proposalOutcomeText}>Applied to your recipe</Text>
                    </View>
                ) : state === 'declined' ? (
                    <View style={styles.proposalOutcome}>
                        <Ionicons name="close-circle-outline" size={16} color={inkMuted} />
                        <Text style={[styles.proposalOutcomeText, { color: inkMuted }]}>Not applied</Text>
                    </View>
                ) : (
                    <View style={styles.proposalActions}>
                        <GlassPressable
                            style={styles.proposalDecline}
                            onPress={() => setProposalState(message.id, 'declined')}
                            disabled={state === 'applying'}
                            accessibilityLabel="Don't change the recipe"
                        >
                            <Text style={styles.proposalDeclineText}>No thanks</Text>
                        </GlassPressable>
                        <GlassPressable
                            style={styles.proposalApply}
                            onPress={() => apply(message)}
                            disabled={state === 'applying'}
                            accessibilityLabel={`Apply this change to your recipe: ${proposal.summary}`}
                        >
                            {state === 'applying'
                                ? <ActivityIndicator size="small" color="#fff" />
                                : <Text style={styles.proposalApplyText}>Apply</Text>}
                        </GlassPressable>
                    </View>
                )}
            </View>
        );
    };

    const renderMessage = ({ item }: { item: AskMessage }) => {
        const isUser = item.role === 'user';
        return (
            <View style={[styles.messageGroup, isUser && styles.messageGroupUser]}>
                <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble, item.isError && styles.errorBubble]}>
                    <Text style={[styles.bubbleText, isUser && styles.userBubbleText]} selectable>{item.text}</Text>
                </View>
                {!isUser && item.proposal && renderProposal(item)}
            </View>
        );
    };

    return (
        <KeyboardAvoidingView
            style={styles.root}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
                <View style={styles.headerIcon}>
                    <Ionicons name="sparkles" size={18} color={primary} />
                </View>
                <View style={{ flex: 1 }}>
                    <Text style={styles.headerTitle}>Ask Fridgie</Text>
                    <Text style={styles.headerSubtitle} numberOfLines={1}>{recipe.name}</Text>
                </View>
                <GlassPressable style={styles.closeButton} onPress={onClose} accessibilityLabel="Close Ask Fridgie">
                    <Ionicons name="close" size={22} color={ink} />
                </GlassPressable>
            </View>

            <FlatList
                ref={listRef}
                style={{ flex: 1 }}
                contentContainerStyle={styles.thread}
                data={messages}
                keyExtractor={(item) => item.id}
                renderItem={renderMessage}
                keyboardShouldPersistTaps="handled"
                ListHeaderComponent={
                    <View style={styles.intro}>
                        <Text style={styles.introText}>
                            {ownsRecipe
                                ? 'Ask about swaps, techniques or timings. If you want the recipe changed, I’ll suggest an edit and you decide whether to apply it.'
                                : 'Ask about swaps, techniques or timings. To have me edit this recipe, make your own copy with the pencil button first.'}
                        </Text>
                        {messages.length === 0 && (
                            <View style={styles.starters}>
                                {starters.map((starter) => (
                                    <GlassPressable
                                        key={starter}
                                        style={styles.starterChip}
                                        onPress={() => send(starter)}
                                        accessibilityLabel={`Ask: ${starter}`}
                                    >
                                        <Text style={styles.starterText}>{starter}</Text>
                                    </GlassPressable>
                                ))}
                            </View>
                        )}
                    </View>
                }
                ListFooterComponent={isSending ? (
                    <View style={[styles.bubble, styles.assistantBubble, styles.thinking]}>
                        <ActivityIndicator size="small" color={primary} />
                        <Text style={styles.thinkingText}>Fridgie is thinking…</Text>
                    </View>
                ) : null}
            />

            <View style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
                <GlassSurface style={styles.composer} intensity={85}>
                    <TextInput
                        style={styles.composerInput}
                        placeholder="Ask about this recipe…"
                        placeholderTextColor={inkFaint}
                        accessibilityLabel="Ask Fridgie a question about this recipe"
                        value={input}
                        onChangeText={setInput}
                        maxLength={MAX_MESSAGE_CHARS}
                        multiline
                    />
                    <GlassPressable
                        style={[styles.sendButton, (!input.trim() || isSending) && styles.sendButtonDisabled]}
                        onPress={() => send(input)}
                        disabled={!input.trim() || isSending}
                        accessibilityLabel="Send question"
                        accessibilityState={{ busy: isSending, disabled: !input.trim() || isSending }}
                    >
                        <Ionicons name="arrow-up" size={20} color="#fff" />
                    </GlassPressable>
                </GlassSurface>
            </View>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    root: { ...StyleSheet.absoluteFillObject, backgroundColor: canvas },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: hairline },
    headerIcon: { width: 38, height: 38, borderRadius: 14, backgroundColor: accentSoft, alignItems: 'center', justifyContent: 'center' },
    headerTitle: { fontSize: 19, fontWeight: '700', letterSpacing: -0.5, color: ink },
    headerSubtitle: { fontSize: 12, color: inkMuted, marginTop: 1 },
    closeButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
    thread: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12 },
    intro: { marginBottom: 14 },
    introText: { fontSize: 13, lineHeight: 20, color: inkMuted },
    starters: { marginTop: 14, gap: 8, alignItems: 'flex-start' },
    starterChip: { backgroundColor: accentSoft, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
    starterText: { fontSize: 13, fontWeight: '600', color: primary },
    messageGroup: { marginBottom: 12, alignItems: 'flex-start' },
    messageGroupUser: { alignItems: 'flex-end' },
    bubble: { borderRadius: 22, paddingVertical: 12, paddingHorizontal: 16, maxWidth: '88%' },
    assistantBubble: { backgroundColor: '#E8EEE3', borderBottomLeftRadius: 6 },
    userBubble: { backgroundColor: primary, borderBottomRightRadius: 6 },
    errorBubble: { backgroundColor: '#F6E3DE' },
    bubbleText: { fontSize: 15, lineHeight: 23, color: ink },
    userBubbleText: { color: '#FFF' },
    thinking: { flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'flex-start' },
    thinkingText: { fontSize: 14, color: inkMuted },
    proposalCard: { marginTop: 8, width: '88%', backgroundColor: surface, borderRadius: 20, padding: 14, borderWidth: 1, borderColor: '#FFF' },
    proposalHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    proposalTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.3, color: primary, textTransform: 'uppercase' },
    proposalSummary: { fontSize: 15, lineHeight: 22, color: ink, marginTop: 6 },
    proposalActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
    proposalDecline: { flex: 1, minHeight: 42, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.7)' },
    proposalDeclineText: { fontSize: 14, fontWeight: '600', color: inkMuted },
    proposalApply: { flex: 1, minHeight: 42, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: primary },
    proposalApplyText: { fontSize: 14, fontWeight: '700', color: '#FFF' },
    proposalOutcome: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
    proposalOutcomeText: { fontSize: 13, fontWeight: '600', color: primary },
    composer: { flexDirection: 'row', alignItems: 'flex-end', marginHorizontal: 12, padding: 7, borderRadius: 28 },
    composerInput: { flex: 1, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 12, fontSize: 15, color: ink, maxHeight: 110 },
    sendButton: { width: 43, height: 43, borderRadius: 22, backgroundColor: primary, alignItems: 'center', justifyContent: 'center', marginLeft: 7 },
    sendButtonDisabled: { backgroundColor: '#BDCFBD' },
});
