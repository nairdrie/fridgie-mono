import CookbookFilterBar from '@/components/CookbookFilterBar';
import { AmbientBackground, GlassPressable, GlassSurface } from '@/components/ui/Glass';
import { useAuth } from '@/context/AuthContext';
import { useCookbookFilter } from '@/hooks/useCookbookFilter';
import type {
  CookbookPrintAddress,
  CookbookPrintDraft,
  CookbookPrintDraftInput,
  CookbookPrintEligibleRecipe,
  CookbookPrintEligibilitySummary,
  CookbookPrintIssue,
  CookbookPrintMoney,
  CookbookPrintPhotoPlacement,
  CookbookPrintPreview,
  CookbookPrintQuote,
  CookbookPrintRecipeSelection,
  CookbookPrintSku,
  CookbookPrintTheme,
} from '@/types/types';
import {
  checkoutCookbookPrintDraft,
  createCookbookPrintDraft,
  generateCookbookPrintPreview,
  getCookbookPrintDraft,
  getCookbookPrintDrafts,
  getCookbookPrintEligibility,
  quoteCookbookPrintDraft,
  updateCookbookPrintDraft,
} from '@/utils/api';
import {
  arePrintAcknowledgementsComplete,
  buildInitialPrintSelections,
  canRequestPrintQuote,
  getCookbookPrintQuoteChange,
  isPrintAddressComplete,
  isPrintPreviewCurrent,
  isPrintQuoteUnexpired,
  reconcilePrintSelections,
  reorderIncludedPrintRecipes,
  restorePrintRecipe,
  setPrintRecipeIncluded,
} from '@/utils/printCookbook';
import { hairline, ink, inkFaint, inkMuted, mint, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import DraggableFlatList, { type RenderItemParams } from 'react-native-draggable-flatlist';
import { SafeAreaView } from 'react-native-safe-area-context';
import { initStripe, useStripe } from '@/utils/stripePayment';

type BuilderStep = 'recipes' | 'design' | 'preview' | 'checkout';
type RecipeMode = 'choose' | 'arrange';
type SaveState = 'saved' | 'saving' | 'error';

const STEPS: { key: BuilderStep; label: string; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
  { key: 'recipes', label: 'Recipes', icon: 'list-outline' },
  { key: 'design', label: 'Design', icon: 'color-palette-outline' },
  { key: 'preview', label: 'Preview', icon: 'eye-outline' },
  { key: 'checkout', label: 'Order', icon: 'card-outline' },
];

const THEMES: { key: CookbookPrintTheme; title: string; detail: string }[] = [
  { key: 'classic', title: 'Classic', detail: 'Warm centered type and generous recipe pages.' },
  { key: 'modern', title: 'Modern', detail: 'Clean structure, bold headings, quiet colour.' },
  { key: 'photo-forward', title: 'Photo-forward', detail: 'Larger food photography with concise text.' },
];

const SKUS: { key: CookbookPrintSku; title: string; detail: string; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
  { key: 'matte-softcover', title: 'Matte softcover', detail: 'Flexible, light, and lovely for everyday cooking.', icon: 'book-outline' },
  { key: 'matte-hardcover', title: 'Matte hardcover', detail: 'A durable keepsake with a printed case.', icon: 'albums-outline' },
];

const PLACEMENTS: { key: CookbookPrintPhotoPlacement; label: string }[] = [
  { key: 'auto', label: 'Auto' },
  { key: 'hero', label: 'Hero' },
  { key: 'inline', label: 'Inline' },
  { key: 'none', label: 'No photo' },
];

const emptyAddress: CookbookPrintAddress = {
  name: '',
  line1: '',
  line2: '',
  city: '',
  stateOrProvince: '',
  postalCode: '',
  country: 'CA',
  phone: '',
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const draftInput = (draft: CookbookPrintDraft): CookbookPrintDraftInput => ({
  title: draft.title,
  subtitle: draft.subtitle,
  dedication: draft.dedication,
  byline: draft.byline,
  theme: draft.theme,
  sku: draft.sku,
  coverRecipeId: draft.coverRecipeId,
  coverCrop: draft.coverCrop,
  includeTableOfContents: draft.includeTableOfContents,
  includeIndex: draft.includeIndex,
  recipes: draft.recipes,
});
const signature = (input: CookbookPrintDraftInput) => JSON.stringify(input);
const addressKey = (address: CookbookPrintAddress) => JSON.stringify(address);

function formatMoney(money: CookbookPrintMoney): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: money.currency }).format(money.amountMinor / 100);
  } catch {
    return `${money.currency} ${(money.amountMinor / 100).toFixed(2)}`;
  }
}

function humanDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function InputField({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  keyboardType,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  keyboardType?: React.ComponentProps<typeof TextInput>['keyboardType'];
  autoCapitalize?: React.ComponentProps<typeof TextInput>['autoCapitalize'];
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.fieldInput, multiline && styles.fieldInputMultiline]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={inkFaint}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
      />
    </View>
  );
}

function CheckRow({ checked, onPress, title, detail }: { checked: boolean; onPress: () => void; title: string; detail?: string }) {
  return (
    <GlassPressable
      style={styles.checkRow}
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={title}
    >
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        {checked && <Ionicons name="checkmark" size={15} color="#fff" />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.checkTitle}>{title}</Text>
        {!!detail && <Text style={styles.checkDetail}>{detail}</Text>}
      </View>
    </GlassPressable>
  );
}

function RecipeSelectionRow({
  recipe,
  selection,
  onSelection,
}: {
  recipe: CookbookPrintEligibleRecipe;
  selection: CookbookPrintRecipeSelection;
  onSelection: (next: CookbookPrintRecipeSelection) => void;
}) {
  const restricted = recipe.printRestriction !== 'none';
  const sourceOnly = selection.rightsMode === 'source-only';
  const toggle = () => onSelection({ ...selection, included: !selection.included });
  const setRights = (rightsMode: 'source-only' | 'rights-confirmed') => onSelection({
    ...selection,
    rightsMode,
    ...(rightsMode === 'source-only' ? { photoPlacement: 'none' as const } : {}),
    ...(rightsMode === 'rights-confirmed' ? { rightsConfirmedAt: new Date().toISOString() } : { rightsConfirmedAt: undefined }),
  });

  return (
    <GlassSurface style={[styles.recipeChoice, selection.included && styles.recipeChoiceSelected]} intensity={38}>
      <View style={styles.recipeChoiceTop}>
        {recipe.photoURL ? <Image source={{ uri: recipe.photoURL }} style={styles.recipeThumb} /> : <View style={[styles.recipeThumb, styles.recipeThumbEmpty]}><Ionicons name="restaurant-outline" size={24} color={primary} /></View>}
        <View style={styles.recipeChoiceCopy}>
          <Text style={styles.recipeEyebrow}>{recipe.category || 'FROM YOUR COOKBOOK'}</Text>
          <Text style={styles.recipeChoiceTitle} numberOfLines={2}>{recipe.name}</Text>
          {!!recipe.authorName && <Text style={styles.recipeMeta} numberOfLines={1}>By {recipe.authorName}</Text>}
        </View>
        <GlassPressable
          style={[styles.selectButton, selection.included && styles.selectButtonOn]}
          onPress={toggle}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: selection.included }}
          accessibilityLabel={`${selection.included ? 'Remove' : 'Include'} ${recipe.name}`}
        >
          <Ionicons name={selection.included ? 'checkmark' : 'add'} size={19} color={selection.included ? '#fff' : primary} />
        </GlassPressable>
      </View>

      {restricted && (
        <View style={styles.rightsPanel}>
          <View style={styles.warningHeading}>
            <Ionicons name="shield-checkmark-outline" size={17} color="#996D38" />
            <Text style={styles.warningTitle}>{recipe.printRestriction === 'external-source'
              ? 'Imported from another source'
              : recipe.printRestriction === 'photo-import'
                ? 'Imported from a photographed page'
                : 'Contributor permission needed'}</Text>
          </View>
          <Text style={styles.warningText}>{recipe.printRestrictionMessage || 'Choose how this recipe may appear in your printed book.'}</Text>
          {selection.included && <>
            <View style={styles.rightsChoices}>
              <GlassPressable style={[styles.rightsChoice, sourceOnly && styles.rightsChoiceOn]} onPress={() => setRights('source-only')} accessibilityState={{ selected: sourceOnly }}>
                <Text style={[styles.rightsChoiceText, sourceOnly && styles.rightsChoiceTextOn]}>Source + my notes</Text>
              </GlassPressable>
              <GlassPressable style={[styles.rightsChoice, !sourceOnly && styles.rightsChoiceOn]} onPress={() => setRights('rights-confirmed')} accessibilityState={{ selected: !sourceOnly }}>
                <Text style={[styles.rightsChoiceText, !sourceOnly && styles.rightsChoiceTextOn]}>I have print rights</Text>
              </GlassPressable>
            </View>
            {sourceOnly && (
              <TextInput
                style={styles.notesInput}
                value={selection.notes || ''}
                onChangeText={(notes) => onSelection({ ...selection, notes })}
                placeholder="Add your own note for this source page (optional)"
                placeholderTextColor={inkFaint}
                multiline
                accessibilityLabel={`Your notes for ${recipe.name}`}
              />
            )}
          </>}
        </View>
      )}
      {!restricted && selection.included && !recipe.photoPrintAllowedByDefault && (
        <View style={styles.smallWarning}><Ionicons name="image-outline" size={15} color="#996D38" /><Text style={styles.smallWarningText}>The recipe can print, but its current photo will be left out.</Text></View>
      )}
    </GlassSurface>
  );
}

function ArrangeRow({
  selection,
  recipe,
  drag,
  isActive,
  photoAllowed,
  onPatch,
  onRemove,
}: {
  selection: CookbookPrintRecipeSelection;
  recipe?: CookbookPrintEligibleRecipe;
  drag: () => void;
  isActive: boolean;
  photoAllowed: boolean;
  onPatch: (patch: Partial<CookbookPrintRecipeSelection>) => void;
  onRemove: () => void;
}) {
  return (
    <GlassSurface style={[styles.arrangeCard, isActive && styles.arrangeCardActive]} intensity={45}>
      <GlassPressable
        haptic={false}
        style={styles.dragHandle}
        onLongPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          drag();
        }}
        disabled={isActive}
        accessibilityLabel={`Reorder ${recipe?.name || 'recipe'}`}
      >
        <Ionicons name="reorder-three" size={25} color={inkMuted} />
      </GlassPressable>
      {recipe?.photoURL ? <Image source={{ uri: recipe.photoURL }} style={styles.arrangeThumb} /> : <View style={[styles.arrangeThumb, styles.recipeThumbEmpty]}><Ionicons name="restaurant-outline" size={20} color={primary} /></View>}
      <View style={styles.arrangeCopy}>
        <Text style={styles.arrangeTitle} numberOfLines={2}>{recipe?.name || 'Recipe no longer available'}</Text>
        <TextInput
          style={styles.sectionInput}
          value={selection.section ?? recipe?.category ?? ''}
          onChangeText={(section) => onPatch({ section })}
          placeholder="Section (optional)"
          placeholderTextColor={inkFaint}
          accessibilityLabel={`Section for ${recipe?.name || 'recipe'}`}
        />
        <View style={styles.placementRow}>
          {PLACEMENTS.map((placement) => (
            <GlassPressable
              key={placement.key}
              style={[styles.placementChip, selection.photoPlacement === placement.key && styles.placementChipOn]}
              onPress={() => onPatch({ photoPlacement: placement.key })}
              disabled={!photoAllowed && placement.key !== 'none'}
              accessibilityState={{ selected: selection.photoPlacement === placement.key }}
            >
              <Text style={[styles.placementText, selection.photoPlacement === placement.key && styles.placementTextOn]}>{placement.label}</Text>
            </GlassPressable>
          ))}
        </View>
        {!photoAllowed && <Text style={styles.arrangePhotoNote}>This photo is not cleared for print.</Text>}
      </View>
      <GlassPressable style={styles.removeRecipe} onPress={onRemove} accessibilityLabel={`Remove ${recipe?.name || 'recipe'} from this book`}>
        <Ionicons name="close" size={19} color={inkMuted} />
      </GlassPressable>
    </GlassSurface>
  );
}

function RemovedTray({
  selections,
  recipes,
  onRestore,
}: {
  selections: CookbookPrintRecipeSelection[];
  recipes: Map<string, CookbookPrintEligibleRecipe>;
  onRestore: (recipeId: string) => void;
}) {
  const removed = selections.filter((selection) => !selection.included).sort((a, b) => a.position - b.position);
  if (!removed.length) return null;
  return (
    <View style={styles.removedTray}>
      <View style={styles.removedHeading}><Ionicons name="archive-outline" size={18} color={inkMuted} /><Text style={styles.removedTitle}>Removed for now</Text><Text style={styles.removedCount}>{removed.length}</Text></View>
      <Text style={styles.removedDetail}>Their place is kept in this draft, so restoring one never loses your work.</Text>
      <View style={styles.removedWrap}>
        {removed.map((selection) => (
          <GlassPressable key={selection.recipeId} style={styles.restoreChip} onPress={() => onRestore(selection.recipeId)} accessibilityLabel={`Restore ${recipes.get(selection.recipeId)?.name || 'recipe'}`}>
            <Ionicons name="add" size={14} color={primary} />
            <Text style={styles.restoreText} numberOfLines={1}>{recipes.get(selection.recipeId)?.name || 'Unavailable recipe'}</Text>
          </GlassPressable>
        ))}
      </View>
    </View>
  );
}

function ThemeCard({ theme, selected, onPress }: { theme: typeof THEMES[number]; selected: boolean; onPress: () => void }) {
  const pageStyle = theme.key === 'classic'
    ? styles.themePage_classic
    : theme.key === 'modern'
      ? styles.themePage_modern
      : styles.themePage_photo_forward;
  return (
    <GlassPressable style={[styles.themeCard, selected && styles.optionSelected]} onPress={onPress} accessibilityState={{ selected }}>
      <View style={[styles.themePage, pageStyle]}>
        <View style={styles.themePhoto} />
        <View style={[styles.themeLine, { width: '72%' }]} />
        <View style={[styles.themeLine, { width: '48%', opacity: 0.45 }]} />
        <View style={styles.themeColumns}><View style={styles.themeColumn} /><View style={styles.themeColumn} /></View>
      </View>
      <Text style={styles.optionTitle}>{theme.title}</Text>
      <Text style={styles.optionDetail}>{theme.detail}</Text>
      {selected && <View style={styles.optionCheck}><Ionicons name="checkmark" size={13} color="#fff" /></View>}
    </GlassPressable>
  );
}

function DesignStep({
  input,
  recipes,
  onInput,
}: {
  input: CookbookPrintDraftInput;
  recipes: CookbookPrintEligibleRecipe[];
  onInput: (updater: (current: CookbookPrintDraftInput) => CookbookPrintDraftInput) => void;
}) {
  const recipeMap = useMemo(() => new Map(recipes.map((recipe) => [recipe.id, recipe])), [recipes]);
  const selected = input.recipes.filter((selection) => selection.included);
  const coverChoices = selected
    .map((selection) => ({ selection, recipe: recipeMap.get(selection.recipeId) }))
    .filter(({ selection, recipe }) => !!recipe?.photoURL && (recipe.photoPrintAllowedByDefault || selection.rightsMode === 'rights-confirmed'));
  const cover = input.coverRecipeId ? recipeMap.get(input.coverRecipeId) : undefined;
  const patch = (partial: Partial<CookbookPrintDraftInput>) => onInput((current) => ({ ...current, ...partial }));
  const crop = input.coverCrop;
  const moveCrop = (x: number, y: number) => patch({ coverCrop: { ...crop, x: clamp(crop.x + x, 0, 1), y: clamp(crop.y + y, 0, 1) } });

  return (
    <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <View style={styles.introBlock}>
        <Text style={styles.eyebrow}>MAKE IT YOURS</Text>
        <Text style={styles.stepTitle}>The book on your shelf</Text>
        <Text style={styles.stepIntro}>These choices are sent to the same renderer that makes your final print files.</Text>
      </View>

      <GlassSurface style={styles.formCard} intensity={48}>
        <Text style={styles.formCardTitle}>Title page</Text>
        <InputField label="Book title" value={input.title} onChangeText={(title) => patch({ title })} placeholder="Our family cookbook" />
        <InputField label="Subtitle (optional)" value={input.subtitle || ''} onChangeText={(subtitle) => patch({ subtitle })} placeholder="Recipes worth keeping" />
        <InputField label="Byline" value={input.byline} onChangeText={(byline) => patch({ byline })} placeholder="By your name" />
        <InputField label="Dedication (optional)" value={input.dedication || ''} onChangeText={(dedication) => patch({ dedication })} placeholder="For everyone who gathers at our table…" multiline />
      </GlassSurface>

      <View style={styles.sectionHeading}><Text style={styles.sectionHeadingTitle}>Choose a cover</Text><Text style={styles.sectionHeadingDetail}>Pick a photo already cleared for this draft.</Text></View>
      {coverChoices.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.coverChoices}>
          {coverChoices.map(({ recipe }) => {
            const active = input.coverRecipeId === recipe!.id;
            return (
              <GlassPressable key={recipe!.id} style={[styles.coverChoice, active && styles.coverChoiceOn]} onPress={() => patch({ coverRecipeId: recipe!.id })} accessibilityState={{ selected: active }} accessibilityLabel={`Use ${recipe!.name} as the cover`}>
                <Image source={{ uri: recipe!.photoURL }} style={styles.coverChoiceImage} />
                <Text style={styles.coverChoiceText} numberOfLines={2}>{recipe!.name}</Text>
                {active && <View style={styles.coverChoiceCheck}><Ionicons name="checkmark" size={12} color="#fff" /></View>}
              </GlassPressable>
            );
          })}
        </ScrollView>
      ) : (
        <GlassSurface style={styles.noCoverPhoto}><Ionicons name="images-outline" size={25} color={primary} /><Text style={styles.noCoverTitle}>A typographic cover will be used</Text><Text style={styles.noCoverText}>Add an eligible recipe photo, or confirm the rights for one, to use photography.</Text></GlassSurface>
      )}

      {!!cover?.photoURL && <GlassSurface style={styles.cropCard} intensity={42}>
        <View style={styles.cropPreview}>
          <Image
            source={{ uri: cover.photoURL }}
            style={[styles.cropImage, { transform: [
              { translateX: (0.5 - crop.x) * 90 },
              { translateY: (0.5 - crop.y) * 110 },
              { scale: crop.zoom },
            ] }]}
          />
          <View style={styles.cropShadeTop} />
          <View style={styles.cropTitlePreview}><Text style={styles.cropTitleText} numberOfLines={3}>{input.title || 'Your cookbook'}</Text><Text style={styles.cropBylineText}>{input.byline}</Text></View>
        </View>
        <View style={styles.cropControls}>
          <Text style={styles.cropLabel}>Position</Text>
          <View style={styles.cropPad}>
            <View style={{ width: 38 }} />
            <GlassPressable style={styles.cropButton} onPress={() => moveCrop(0, -0.08)} accessibilityLabel="Move cover photo up"><Ionicons name="chevron-up" size={18} color={ink} /></GlassPressable>
            <View style={{ width: 38 }} />
            <GlassPressable style={styles.cropButton} onPress={() => moveCrop(-0.08, 0)} accessibilityLabel="Move cover photo left"><Ionicons name="chevron-back" size={18} color={ink} /></GlassPressable>
            <View style={styles.cropCenter} />
            <GlassPressable style={styles.cropButton} onPress={() => moveCrop(0.08, 0)} accessibilityLabel="Move cover photo right"><Ionicons name="chevron-forward" size={18} color={ink} /></GlassPressable>
            <View style={{ width: 38 }} />
            <GlassPressable style={styles.cropButton} onPress={() => moveCrop(0, 0.08)} accessibilityLabel="Move cover photo down"><Ionicons name="chevron-down" size={18} color={ink} /></GlassPressable>
            <View style={{ width: 38 }} />
          </View>
          <Text style={styles.cropLabel}>Zoom</Text>
          <View style={styles.zoomRow}>
            <GlassPressable style={styles.zoomButton} onPress={() => patch({ coverCrop: { ...crop, zoom: clamp(crop.zoom - 0.1, 1, 3) } })} accessibilityLabel="Zoom cover photo out"><Ionicons name="remove" size={18} color={ink} /></GlassPressable>
            <Text style={styles.zoomValue}>{Math.round(crop.zoom * 100)}%</Text>
            <GlassPressable style={styles.zoomButton} onPress={() => patch({ coverCrop: { ...crop, zoom: clamp(crop.zoom + 0.1, 1, 3) } })} accessibilityLabel="Zoom cover photo in"><Ionicons name="add" size={18} color={ink} /></GlassPressable>
          </View>
        </View>
      </GlassSurface>}

      <View style={styles.sectionHeading}><Text style={styles.sectionHeadingTitle}>Page style</Text><Text style={styles.sectionHeadingDetail}>Your choice changes the actual printed layout.</Text></View>
      <View style={styles.themeGrid}>{THEMES.map((theme) => <ThemeCard key={theme.key} theme={theme} selected={input.theme === theme.key} onPress={() => patch({ theme: theme.key })} />)}</View>

      <View style={styles.sectionHeading}><Text style={styles.sectionHeadingTitle}>Book format</Text><Text style={styles.sectionHeadingDetail}>Two matte finishes, both printed in colour.</Text></View>
      <View style={styles.skuGrid}>{SKUS.map((sku) => {
        const active = input.sku === sku.key;
        return <GlassPressable key={sku.key} style={[styles.skuCard, active && styles.optionSelected]} onPress={() => patch({ sku: sku.key })} accessibilityState={{ selected: active }}><View style={styles.skuIcon}><Ionicons name={sku.icon} size={25} color={primary} /></View><View style={{ flex: 1 }}><Text style={styles.optionTitle}>{sku.title}</Text><Text style={styles.optionDetail}>{sku.detail}</Text></View>{active && <Ionicons name="checkmark-circle" size={22} color={primary} />}</GlassPressable>;
      })}</View>

      <GlassSurface style={styles.formCard} intensity={40}>
        <Text style={styles.formCardTitle}>Book furniture</Text>
        <CheckRow checked={input.includeTableOfContents} onPress={() => patch({ includeTableOfContents: !input.includeTableOfContents })} title="Table of contents" detail="Recipe and section page numbers at the front." />
        <CheckRow checked={input.includeIndex} onPress={() => patch({ includeIndex: !input.includeIndex })} title="Recipe index" detail="An alphabetical index when the final page count allows it." />
      </GlassSurface>
    </ScrollView>
  );
}

function IssueRow({ issue }: { issue: CookbookPrintIssue }) {
  const color = issue.severity === 'error' ? '#A94E48' : issue.severity === 'warning' ? '#996D38' : primary;
  return (
    <View style={styles.issueRow}>
      <Ionicons name={issue.severity === 'error' ? 'close-circle' : issue.severity === 'warning' ? 'warning' : 'information-circle'} size={20} color={color} />
      <View style={{ flex: 1 }}><Text style={[styles.issueSeverity, { color }]}>{issue.severity.toUpperCase()}{issue.pageNumber ? ` · PAGE ${issue.pageNumber}` : ''}</Text><Text style={styles.issueMessage}>{issue.message}</Text></View>
    </View>
  );
}

function PreviewStep({ preview, current, loading, onGenerate }: { preview: CookbookPrintPreview | null; current: boolean; loading: boolean; onGenerate: () => void }) {
  const { width } = useWindowDimensions();
  const pageWidth = Math.min(width - 56, 410);
  if (loading) return <View style={styles.centered}><ActivityIndicator size="large" color={primary} /><Text style={styles.loadingTitle}>Laying out every page…</Text><Text style={styles.loadingDetail}>Checking photos, page breaks, the spine, and the print provider’s file rules.</Text></View>;
  if (!preview) return <View style={styles.centered}><View style={styles.largeIcon}><Ionicons name="book-outline" size={36} color={primary} /></View><Text style={styles.loadingTitle}>Your pages are ready to take shape</Text><Text style={styles.loadingDetail}>Fridgie generates the preview from the same layout inputs used for the print-ready files.</Text><GlassPressable style={styles.primaryButton} onPress={onGenerate}><Text style={styles.primaryButtonText}>Generate page preview</Text><Ionicons name="sparkles-outline" size={18} color="#fff" /></GlassPressable></View>;
  return (
    <ScrollView contentContainerStyle={styles.previewContent} showsVerticalScrollIndicator={false}>
      {!current && <View style={styles.staleBanner}><Ionicons name="refresh-outline" size={19} color="#996D38" /><View style={{ flex: 1 }}><Text style={styles.staleTitle}>Your draft changed</Text><Text style={styles.staleText}>Regenerate before ordering so the preview matches the saved book.</Text></View><GlassPressable style={styles.regenerateSmall} onPress={onGenerate}><Text style={styles.regenerateText}>Update</Text></GlassPressable></View>}
      <View style={styles.previewSummary}><View><Text style={styles.eyebrow}>PRINT PREVIEW</Text><Text style={styles.previewCount}>{preview.pageCount} pages</Text></View><View style={styles.spinePill}><Ionicons name="resize-outline" size={14} color={primary} /><Text style={styles.spineText}>{preview.spineWidthInches.toFixed(3)} in spine</Text></View></View>
      <FlatList
        horizontal
        pagingEnabled
        decelerationRate="fast"
        snapToInterval={pageWidth + 14}
        showsHorizontalScrollIndicator={false}
        data={preview.pages}
        keyExtractor={(page) => `${page.pageNumber}:${page.kind}`}
        contentContainerStyle={styles.pageRail}
        renderItem={({ item }) => <View style={[styles.pageCard, { width: pageWidth }]}>
          {item.imageUrl ? <Image source={{ uri: item.imageUrl }} style={styles.pageImage} resizeMode="contain" /> : <View style={styles.pageUnavailable}><Ionicons name="document-outline" size={36} color={inkFaint} /><Text style={styles.pageUnavailableTitle}>Page image unavailable</Text><Text style={styles.pageUnavailableText}>{item.label}</Text></View>}
          <View style={styles.pageCaption}><Text style={styles.pageNumber}>PAGE {item.pageNumber}</Text><Text style={styles.pageLabel} numberOfLines={1}>{item.label}</Text></View>
        </View>}
      />
      <Text style={styles.swipeHint}>Swipe to review every page</Text>
      <GlassSurface style={styles.preflightCard} intensity={45}>
        <View style={styles.preflightHeading}><View><Text style={styles.formCardTitle}>Preflight</Text><Text style={styles.preflightDetail}>{preview.issues.length ? `${preview.issues.length} item${preview.issues.length === 1 ? '' : 's'} to review` : 'Every automated check passed'}</Text></View><Ionicons name={preview.canOrder ? 'checkmark-circle' : 'alert-circle'} size={29} color={preview.canOrder ? primary : '#A94E48'} /></View>
        {preview.issues.length ? preview.issues.map((issue, index) => <IssueRow key={`${issue.code}:${issue.pageNumber ?? ''}:${index}`} issue={issue} />) : <View style={styles.allClear}><Ionicons name="leaf-outline" size={18} color={primary} /><Text style={styles.allClearText}>No missing images, overflow, awkward breaks, empty pages, or provider file errors were found.</Text></View>}
      </GlassSurface>
      <GlassPressable style={styles.secondaryWide} onPress={onGenerate}><Ionicons name="refresh-outline" size={17} color={primary} /><Text style={styles.secondaryWideText}>Regenerate preview</Text></GlassPressable>
    </ScrollView>
  );
}

function QuoteCard({ quote }: { quote: CookbookPrintQuote }) {
  const lines: { label: string; money: CookbookPrintMoney; discount?: boolean }[] = [
    { label: 'Printing', money: quote.printing },
    { label: 'Shipping', money: quote.shipping },
    { label: 'Tax', money: quote.tax },
  ];
  if (quote.discount.amountMinor) lines.push({ label: 'Discount', money: quote.discount, discount: true });
  return (
    <GlassSurface style={styles.quoteCard} intensity={52}>
      <View style={styles.quoteHeading}><View><Text style={styles.eyebrow}>LIVE QUOTE · {quote.providerName.toUpperCase()}</Text><Text style={styles.quoteMethod}>{quote.shippingMethod}</Text></View><Text style={styles.quoteExpiry}>Until {humanDate(quote.expiresAt)}</Text></View>
      {lines.map(({ label, money, discount }) => <View key={label} style={styles.priceRow}><Text style={styles.priceLabel}>{label}{label === 'Tax' && quote.taxStatus === 'unavailable' ? ' (not available)' : ''}</Text><Text style={styles.priceValue}>{discount && money.amountMinor > 0 ? '−' : ''}{formatMoney(money)}</Text></View>)}
      <View style={styles.totalRow}><View><Text style={styles.totalLabel}>Total</Text><Text style={styles.currencyLabel}>{quote.total.currency} · one copy</Text></View><Text style={styles.totalValue}>{formatMoney(quote.total)}</Text></View>
      {(quote.productionEstimate || quote.deliveryEstimate) && <View style={styles.estimateBox}><Ionicons name="time-outline" size={18} color={primary} /><View style={{ flex: 1 }}>{!!quote.productionEstimate && <Text style={styles.estimateText}>Production: {quote.productionEstimate}</Text>}{!!quote.deliveryEstimate && <Text style={styles.estimateText}>Delivery: {quote.deliveryEstimate}</Text>}</View></View>}
    </GlassSurface>
  );
}

function CheckoutStep({
  address,
  onAddress,
  quote,
  quoting,
  quoteError,
  onQuote,
  acknowledgements,
  onAcknowledgements,
  paying,
  paymentError,
  pendingOrderId,
  onPay,
  onOpenOrder,
}: {
  address: CookbookPrintAddress;
  onAddress: (address: CookbookPrintAddress) => void;
  quote: CookbookPrintQuote | null;
  quoting: boolean;
  quoteError: string | null;
  onQuote: () => void;
  acknowledgements: { rights: boolean; reviewed: boolean; provider: boolean };
  onAcknowledgements: (value: { rights: boolean; reviewed: boolean; provider: boolean }) => void;
  paying: boolean;
  paymentError: string | null;
  pendingOrderId: string | null;
  onPay: () => void;
  onOpenOrder: (orderId: string) => void;
}) {
  const field = (key: keyof CookbookPrintAddress) => (value: string) => onAddress({ ...address, [key]: value });
  return (
    <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <View style={styles.introBlock}><Text style={styles.eyebrow}>PRINTED FOR YOU</Text><Text style={styles.stepTitle}>Delivery and payment</Text><Text style={styles.stepIntro}>Your total comes from the printer using this exact destination. Nothing is charged until you approve PaymentSheet.</Text></View>
      <GlassSurface style={styles.formCard} intensity={46}>
        <Text style={styles.formCardTitle}>Shipping address</Text>
        <InputField label="Full name" value={address.name} onChangeText={field('name')} autoCapitalize="words" />
        <InputField label="Address" value={address.line1} onChangeText={field('line1')} placeholder="Street and number" autoCapitalize="words" />
        <InputField label="Apartment, unit, etc. (optional)" value={address.line2 || ''} onChangeText={field('line2')} />
        <View style={styles.twoFields}><View style={{ flex: 1 }}><InputField label="City" value={address.city} onChangeText={field('city')} autoCapitalize="words" /></View><View style={{ flex: 1 }}><InputField label="Province / state code" value={address.stateOrProvince} onChangeText={(value) => field('stateOrProvince')(value.slice(0, 3).toUpperCase())} placeholder="ON" autoCapitalize="characters" /></View></View>
        <View style={styles.twoFields}><View style={{ flex: 1 }}><InputField label="Postal / ZIP code" value={address.postalCode} onChangeText={field('postalCode')} autoCapitalize="characters" /></View><View style={{ width: 108 }}><InputField label="Country" value={address.country} onChangeText={(value) => field('country')(value.slice(0, 2).toUpperCase())} placeholder="CA" autoCapitalize="characters" /></View></View>
        <InputField label="Delivery phone" value={address.phone} onChangeText={(value) => field('phone')(value.slice(0, 20))} keyboardType="phone-pad" />
        <GlassPressable style={styles.quoteButton} onPress={onQuote} disabled={quoting}>{quoting ? <ActivityIndicator color="#fff" /> : <><Text style={styles.primaryButtonText}>{quote ? 'Refresh complete price' : 'Get complete price'}</Text><Ionicons name="arrow-forward" size={18} color="#fff" /></>}</GlassPressable>
        {!!quoteError && <Text style={styles.inlineError}>{quoteError}</Text>}
      </GlassSurface>
      {quote && <QuoteCard quote={quote} />}
      <GlassSurface style={styles.consentCard} intensity={42}>
        <Text style={styles.formCardTitle}>Before payment</Text>
        <CheckRow checked={acknowledgements.rights} onPress={() => onAcknowledgements({ ...acknowledgements, rights: !acknowledgements.rights })} title="I have the rights or permission I selected" detail="Imported and contributed material is printed only under the choice shown in this draft." />
        <CheckRow checked={acknowledgements.reviewed} onPress={() => onAcknowledgements({ ...acknowledgements, reviewed: !acknowledgements.reviewed })} title="I reviewed every page" detail="I checked the page-by-page preview, including warnings and attribution pages." />
        <CheckRow checked={acknowledgements.provider} onPress={() => onAcknowledgements({ ...acknowledgements, provider: !acknowledgements.provider })} title="Send this order to Lulu" detail="Fridgie may securely transmit the print files and shipping details to Lulu, its print and fulfillment provider." />
      </GlassSurface>
      {!!paymentError && <View style={styles.paymentError}><Ionicons name="alert-circle-outline" size={21} color="#A94E48" /><View style={{ flex: 1 }}><Text style={styles.paymentErrorTitle}>Payment was not completed</Text><Text style={styles.paymentErrorText}>{paymentError}</Text>{pendingOrderId && <GlassPressable style={styles.pendingOrderButton} onPress={() => onOpenOrder(pendingOrderId)}><Text style={styles.pendingOrderText}>View the saved order</Text><Ionicons name="arrow-forward" size={15} color={primary} /></GlassPressable>}</View></View>}
      <GlassPressable style={styles.payButton} onPress={onPay} disabled={paying || !quote}>{paying ? <ActivityIndicator color="#fff" /> : <><Ionicons name="lock-closed-outline" size={18} color="#fff" /><Text style={styles.payButtonText}>{quote ? `Continue to payment · ${formatMoney(quote.total)}` : 'Get a quote to continue'}</Text></>}</GlassPressable>
      <View style={styles.secureNote}><Ionicons name="shield-checkmark-outline" size={16} color={inkMuted} /><Text style={styles.secureText}>Card and Apple Pay details are handled by Stripe. Fridgie never stores your card number.</Text></View>
    </ScrollView>
  );
}

export default function PrintCookbookBuilder() {
  const router = useRouter();
  const { user } = useAuth();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const [step, setStep] = useState<BuilderStep>('recipes');
  const [recipeMode, setRecipeMode] = useState<RecipeMode>('choose');
  const [eligibility, setEligibility] = useState<CookbookPrintEligibilitySummary | null>(null);
  const [draft, setDraft] = useState<CookbookPrintDraft | null>(null);
  const [input, setInput] = useState<CookbookPrintDraftInput | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [preview, setPreview] = useState<CookbookPrintPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [address, setAddressState] = useState<CookbookPrintAddress>(emptyAddress);
  const [quote, setQuote] = useState<CookbookPrintQuote | null>(null);
  const [quoteRevision, setQuoteRevision] = useState<number | null>(null);
  const [quotedAddress, setQuotedAddress] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [acks, setAcks] = useState({ rights: false, reviewed: false, provider: false });
  const [paying, setPaying] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);
  const draftRef = useRef<CookbookPrintDraft | null>(null);
  const inputRef = useRef<CookbookPrintDraftInput | null>(null);
  const savedSignature = useRef('');
  const savePromise = useRef<Promise<CookbookPrintDraft> | null>(null);
  const checkoutKey = useRef(Crypto.randomUUID());

  draftRef.current = draft;
  inputRef.current = input;
  const filter = useCookbookFilter(eligibility?.recipes ?? []);
  const recipeMap = useMemo(() => new Map((eligibility?.recipes ?? []).map((recipe) => [recipe.id, recipe])), [eligibility]);
  const included = useMemo(() => (input?.recipes ?? []).filter((selection) => selection.included).sort((a, b) => a.position - b.position), [input?.recipes]);

  const setWorking = useCallback((updater: (current: CookbookPrintDraftInput) => CookbookPrintDraftInput) => {
    setInput((current) => current ? updater(current) : current);
  }, []);

  const persistNow = useCallback(async function saveLoop(): Promise<CookbookPrintDraft> {
    if (savePromise.current) {
      await savePromise.current;
      if (inputRef.current && signature(inputRef.current) !== savedSignature.current) return saveLoop();
      return draftRef.current!;
    }
    const currentDraft = draftRef.current;
    const currentInput = inputRef.current;
    if (!currentDraft || !currentInput) throw new Error('The draft is not ready yet.');
    const sentSignature = signature(currentInput);
    if (sentSignature === savedSignature.current) return currentDraft;
    setSaveState('saving');
    const request = updateCookbookPrintDraft(currentDraft.id, currentInput, currentDraft.revision);
    savePromise.current = request;
    let saved: CookbookPrintDraft;
    try {
      saved = await request;
      draftRef.current = saved;
      setDraft(saved);
      savedSignature.current = sentSignature;
      setSaveState('saved');
    } catch (error: any) {
      if (error?.status === 409) {
        const latest = await getCookbookPrintDraft(currentDraft.id);
        const latestInput = draftInput(latest);
        draftRef.current = latest;
        inputRef.current = latestInput;
        savedSignature.current = signature(latestInput);
        setDraft(latest);
        setInput(latestInput);
        setSaveState('saved');
        Alert.alert('Draft updated elsewhere', 'Fridgie loaded the newest saved version so changes from another device are not overwritten.');
        return latest;
      }
      setSaveState('error');
      throw error;
    } finally {
      savePromise.current = null;
    }
    if (inputRef.current && signature(inputRef.current) !== sentSignature) return saveLoop();
    return saved;
  }, []);

  useEffect(() => {
    if (!input || !draft || signature(input) === savedSignature.current) return;
    setSaveState('saving');
    const timer = setTimeout(() => { void persistNow().catch(() => {}); }, 800);
    return () => clearTimeout(timer);
  }, [input, draft, persistNow]);

  useEffect(() => {
    if (!user || user.isAnonymous) return;
    let ignore = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [summary, drafts] = await Promise.all([getCookbookPrintEligibility(), getCookbookPrintDrafts()]);
        if (ignore) return;
        setEligibility(summary);
        const active = drafts.filter((candidate) => candidate.status === 'active').sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
        if (active) {
          const reconciled = { ...draftInput(active), recipes: reconcilePrintSelections(summary.recipes, active.recipes) };
          draftRef.current = active;
          inputRef.current = reconciled;
          savedSignature.current = signature(draftInput(active));
          setDraft(active);
          setInput(reconciled);
          return;
        }
        const name = user.displayName?.trim() || 'My';
        const initial: CookbookPrintDraftInput = {
          title: name === 'My' ? 'My Cookbook' : `${name}’s Cookbook`,
          subtitle: 'Recipes worth keeping',
          byline: user.displayName?.trim() || 'A Fridgie cook',
          theme: 'classic',
          sku: 'matte-softcover',
          coverRecipeId: summary.recipes.find((recipe) => recipe.photoURL && recipe.photoPrintAllowedByDefault)?.id,
          coverCrop: { x: 0.5, y: 0.5, zoom: 1 },
          includeTableOfContents: true,
          includeIndex: false,
          recipes: buildInitialPrintSelections(summary.recipes),
        };
        const created = await createCookbookPrintDraft(initial);
        if (ignore) return;
        draftRef.current = created;
        inputRef.current = draftInput(created);
        savedSignature.current = signature(draftInput(created));
        setDraft(created);
        setInput(draftInput(created));
      } catch (error: any) {
        if (!ignore) setLoadError(error?.message || 'Could not open your cookbook draft.');
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => { ignore = true; };
  }, [user]);

  const patchSelection = useCallback((next: CookbookPrintRecipeSelection) => {
    setWorking((current) => {
      const recipe = recipeMap.get(next.recipeId);
      const photoAllowed = next.included
        && !!recipe?.photoURL
        && (recipe.photoPrintAllowedByDefault || next.rightsMode === 'rights-confirmed');
      return {
        ...current,
        ...(current.coverRecipeId === next.recipeId && !photoAllowed ? { coverRecipeId: undefined } : {}),
        recipes: current.recipes.map((selection) => selection.recipeId === next.recipeId ? next : selection),
      };
    });
  }, [recipeMap, setWorking]);

  const setIncluded = useCallback((recipeId: string, value: boolean) => {
    setWorking((current) => ({
      ...current,
      ...(!value && current.coverRecipeId === recipeId ? { coverRecipeId: undefined } : {}),
      recipes: setPrintRecipeIncluded(current.recipes, recipeId, value),
    }));
  }, [setWorking]);

  const restore = useCallback((recipeId: string) => {
    setWorking((current) => ({ ...current, recipes: restorePrintRecipe(current.recipes, recipeId) }));
  }, [setWorking]);

  const reorder = useCallback((data: CookbookPrintRecipeSelection[]) => {
    setWorking((current) => ({ ...current, recipes: reorderIncludedPrintRecipes(current.recipes, data.map((selection) => selection.recipeId)) }));
  }, [setWorking]);

  const previewCurrent = !!draft
    && isPrintPreviewCurrent(preview, draft)
    && !!input
    && signature(input) === savedSignature.current;

  const generatePreview = useCallback(async () => {
    if (!inputRef.current || inputRef.current.recipes.every((selection) => !selection.included)) {
      Alert.alert('Choose at least one recipe', 'A cookbook needs something delicious inside it.');
      return;
    }
    setPreviewing(true);
    setPreviewError(null);
    try {
      const saved = await persistNow();
      const result = await generateCookbookPrintPreview(saved.id);
      setPreview(result);
      setQuote(null);
      setQuoteRevision(null);
      setAcks((current) => ({ ...current, reviewed: false }));
    } catch (error: any) {
      setPreviewError(error?.message || 'Could not render the page preview.');
    } finally {
      setPreviewing(false);
    }
  }, [persistNow]);

  const setAddress = useCallback((next: CookbookPrintAddress) => {
    setAddressState(next);
    if (quote && addressKey(next) !== quotedAddress) {
      setQuote(null);
      setQuoteRevision(null);
      checkoutKey.current = Crypto.randomUUID();
    }
  }, [quote, quotedAddress]);

  const requestQuote = useCallback(async () => {
    if (!isPrintAddressComplete(address)) {
      setQuoteError('Complete the name and shipping address first.');
      return;
    }
    if (!draftRef.current || !canRequestPrintQuote({ draft: draftRef.current, preview, address }) || !previewCurrent) {
      setQuoteError('Generate and clear the latest page preview before requesting a price.');
      return;
    }
    setQuoting(true);
    setQuoteError(null);
    try {
      const saved = await persistNow();
      const result = await quoteCookbookPrintDraft(saved.id, { ...address, country: address.country.trim().toUpperCase() });
      setQuote(result);
      setQuoteRevision(saved.revision);
      setQuotedAddress(addressKey(address));
      checkoutKey.current = Crypto.randomUUID();
    } catch (error: any) {
      setQuoteError(error?.message || 'Could not get a print and delivery quote.');
    } finally {
      setQuoting(false);
    }
  }, [address, persistNow, preview, previewCurrent]);

  const openOrder = useCallback((orderId: string, confirmed = false) => {
    router.push({ pathname: '/print-cookbook/orders/[orderId]', params: { orderId, ...(confirmed ? { confirmed: '1' } : {}) } } as any);
  }, [router]);

  const pay = useCallback(async () => {
    if (!quote || !draftRef.current) return;
    if (!isPrintQuoteUnexpired(quote)) {
      setPaymentError('This quote expired. Refresh the complete price before paying.');
      setQuote(null);
      return;
    }
    if (quoteRevision !== draftRef.current.revision || quotedAddress !== addressKey(address)) {
      setPaymentError('The book or address changed after this quote. Refresh the price before paying.');
      setQuote(null);
      return;
    }
    if (!previewCurrent || !preview?.canOrder) {
      setPaymentError('The current draft needs a fresh, order-ready page preview.');
      return;
    }
    if (!arePrintAcknowledgementsComplete({
      rightsConfirmed: acks.rights,
      reviewedEveryPage: acks.reviewed,
      providerConsent: acks.provider,
    })) {
      setPaymentError('Confirm all three review and permission statements before payment.');
      return;
    }
    if (Platform.OS === 'web') {
      setPaymentError('Secure checkout is available in the Fridgie iOS or Android app.');
      return;
    }
    setPaying(true);
    setPaymentError(null);
    try {
      const saved = await persistNow();
      const session = await checkoutCookbookPrintDraft(saved.id, {
        quoteId: quote.id,
        address,
        checkoutKey: checkoutKey.current,
        rightsConfirmed: acks.rights,
        reviewedEveryPage: acks.reviewed,
        providerConsent: acks.provider,
      });
      setPendingOrderId(session.order.id);
      // A prior PaymentSheet may have authorized the same idempotent order
      // before the app lost its response. The server resumes fulfillment in
      // that case; never present a completed/authorized intent a second time.
      if (session.order.paymentStatus !== 'requires-payment') {
        router.replace({ pathname: '/print-cookbook/orders/[orderId]', params: { orderId: session.order.id, confirmed: '1' } } as any);
        return;
      }
      if (!session.publishableKey || !session.paymentIntentClientSecret) throw new Error('Secure payment is not configured for this order.');
      const merchantIdentifier = process.env.EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER ?? 'merchant.com.nairdrie.fridgie';
      await initStripe({ publishableKey: session.publishableKey, merchantIdentifier, urlScheme: 'fridgie' });
      const init = await initPaymentSheet({
        merchantDisplayName: session.merchantDisplayName || 'Fridgie',
        paymentIntentClientSecret: session.paymentIntentClientSecret,
        returnURL: 'fridgie://stripe-redirect',
        allowsDelayedPaymentMethods: false,
        defaultShippingDetails: {
          name: address.name,
          phone: address.phone,
          address: {
            line1: address.line1,
            line2: address.line2,
            city: address.city,
            state: address.stateOrProvince,
            postalCode: address.postalCode,
            country: address.country.toUpperCase(),
          },
        },
        ...(Platform.OS === 'ios' ? { applePay: { merchantCountryCode: process.env.EXPO_PUBLIC_STRIPE_MERCHANT_COUNTRY ?? 'CA' } } : {}),
        ...(Platform.OS === 'android' ? { googlePay: { merchantCountryCode: process.env.EXPO_PUBLIC_STRIPE_MERCHANT_COUNTRY ?? 'CA', testEnv: session.publishableKey.startsWith('pk_test_') } } : {}),
        appearance: {
          colors: { primary, background: '#F5F5EF', componentBackground: '#FFFFFF', componentBorder: '#DCE5DC', componentDivider: '#DCE5DC', primaryText: ink, secondaryText: inkMuted, componentText: ink, placeholderText: inkFaint, icon: primary, error: '#A94E48' },
          shapes: { borderRadius: 18, borderWidth: 1 },
          primaryButton: { colors: { background: primary, text: '#FFFFFF', border: primary }, shapes: { borderRadius: 18, borderWidth: 0 } },
        },
      });
      if (init.error) throw new Error(init.error.message);
      const presented = await presentPaymentSheet();
      if (presented.error) {
        if (presented.error.code === 'Canceled') {
          setPaymentError('You closed the payment sheet. No new payment was submitted; the recoverable order is still in your history.');
          return;
        }
        throw new Error(presented.error.message);
      }
      router.replace({ pathname: '/print-cookbook/orders/[orderId]', params: { orderId: session.order.id, confirmed: '1' } } as any);
    } catch (error: any) {
      const currentDraft = draftRef.current;
      const quoteChange = getCookbookPrintQuoteChange(error, currentDraft ?? undefined);
      if (quoteChange) {
        const usableReplacement = quoteChange.replacementQuote;
        setQuote(usableReplacement);
        setQuoteRevision(usableReplacement ? currentDraft?.revision ?? null : null);
        setQuotedAddress(usableReplacement ? addressKey(address) : null);
        checkoutKey.current = Crypto.randomUUID();
        setPaymentError(usableReplacement
          ? 'The complete price changed. Review the refreshed total, then continue to payment again.'
          : error?.message || 'The saved price changed. Refresh it before paying.');
        return;
      }
      setPaymentError(error?.message || 'Payment could not be started. Your recoverable order remains in order history.');
    } finally {
      setPaying(false);
    }
  }, [acks, address, initPaymentSheet, persistNow, presentPaymentSheet, preview, previewCurrent, quote, quoteRevision, quotedAddress, router]);

  const continueStep = async () => {
    if (!input) return;
    if (step === 'recipes') {
      if (!included.length) return Alert.alert('Choose at least one recipe', 'Select the recipes you want in this edition.');
      setStep('design');
      return;
    }
    if (step === 'design') {
      if (!input.title.trim() || !input.byline.trim()) return Alert.alert('Add a title and byline', 'Both appear on the printed title page.');
      setStep('preview');
      if (!previewCurrent) void generatePreview();
      return;
    }
    if (step === 'preview') {
      if (!previewCurrent || !preview?.canOrder) return Alert.alert('Review the current preview', 'Resolve blocking checks and generate the latest pages before ordering.');
      setAcks((current) => ({ ...current, reviewed: false }));
      setStep('checkout');
    }
  };

  const goBack = () => {
    const index = STEPS.findIndex((item) => item.key === step);
    if (index <= 0) router.back();
    else setStep(STEPS[index - 1]!.key);
  };

  if (!user || user.isAnonymous) {
    return <AmbientBackground><SafeAreaView style={styles.centered}><View style={styles.largeIcon}><Ionicons name="person-outline" size={34} color={primary} /></View><Text style={styles.loadingTitle}>Sign in to print your cookbook</Text><Text style={styles.loadingDetail}>Drafts, payment, and delivery details belong to your Fridgie account.</Text><GlassPressable style={styles.primaryButton} onPress={() => router.push('/login')}><Text style={styles.primaryButtonText}>Sign in</Text></GlassPressable></SafeAreaView></AmbientBackground>;
  }

  if (loading) return <AmbientBackground><SafeAreaView style={styles.centered}><ActivityIndicator size="large" color={primary} /><Text style={styles.loadingTitle}>Opening your cookbook draft…</Text></SafeAreaView></AmbientBackground>;
  if (loadError || !eligibility || !input || !draft) return <AmbientBackground><SafeAreaView style={styles.centered}><View style={styles.largeIcon}><Ionicons name="cloud-offline-outline" size={34} color={primary} /></View><Text style={styles.loadingTitle}>Your draft stayed safely put</Text><Text style={styles.loadingDetail}>{loadError || 'The draft could not be loaded.'}</Text><GlassPressable style={styles.primaryButton} onPress={() => router.replace('/print-cookbook' as any)}><Text style={styles.primaryButtonText}>Try again</Text></GlassPressable><GlassPressable style={styles.textButton} onPress={() => router.back()}><Text style={styles.textButtonText}>Back to profile</Text></GlassPressable></SafeAreaView></AmbientBackground>;

  return (
    <AmbientBackground>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.screen}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
          <View style={styles.header}>
            <GlassPressable style={styles.headerButton} onPress={goBack} accessibilityLabel={step === 'recipes' ? 'Close cookbook builder' : 'Previous step'}><Ionicons name={step === 'recipes' ? 'close' : 'chevron-back'} size={22} color={ink} /></GlassPressable>
            <View style={styles.headerCopy}><Text style={styles.headerEyebrow}>PRINT YOUR COOKBOOK</Text><View style={styles.saveRow}><View style={[styles.saveDot, saveState === 'error' && styles.saveDotError, saveState === 'saving' && styles.saveDotSaving]} /><Text style={styles.saveText}>{saveState === 'saving' ? 'Saving draft…' : saveState === 'error' ? 'Save needs another try' : 'Draft saved'}</Text></View></View>
            <GlassPressable style={styles.headerButton} onPress={() => router.push('/print-cookbook/orders' as any)} accessibilityLabel="Cookbook order history"><Ionicons name="receipt-outline" size={21} color={ink} /></GlassPressable>
          </View>
          <View style={styles.steps}>
            {STEPS.map((item, index) => {
              const current = item.key === step;
              const completed = STEPS.findIndex((candidate) => candidate.key === step) > index;
              return <View key={item.key} style={styles.stepItem}><View style={[styles.stepIcon, (current || completed) && styles.stepIconOn]}><Ionicons name={completed ? 'checkmark' : item.icon} size={15} color={current || completed ? '#fff' : inkFaint} /></View><Text style={[styles.stepLabel, current && styles.stepLabelOn]}>{item.label}</Text></View>;
            })}
          </View>

          <View style={styles.body}>
            {step === 'recipes' && recipeMode === 'choose' && <FlatList<CookbookPrintEligibleRecipe>
              data={filter.recipes as CookbookPrintEligibleRecipe[]}
              keyExtractor={(recipe) => recipe.id}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.recipeList}
              ListHeaderComponent={<>
                <View style={styles.introBlock}><Text style={styles.eyebrow}>CURATE THIS EDITION</Text><Text style={styles.stepTitle}>Choose what belongs</Text><Text style={styles.stepIntro}>{included.length} selected · {eligibility.restrictedCount} with special print choices</Text></View>
                <View style={styles.modeTabs}><GlassPressable style={[styles.modeTab, styles.modeTabOn]} onPress={() => setRecipeMode('choose')}><Text style={[styles.modeText, styles.modeTextOn]}>Choose</Text></GlassPressable><GlassPressable style={styles.modeTab} onPress={() => setRecipeMode('arrange')}><Text style={styles.modeText}>Arrange · {included.length}</Text></GlassPressable></View>
                <GlassSurface style={styles.searchBox} intensity={55}><Ionicons name="search-outline" size={19} color={primary} /><TextInput style={styles.searchInput} placeholder="Search your cookbook" placeholderTextColor={inkMuted} value={filter.searchTerm} onChangeText={filter.setSearchTerm} accessibilityLabel="Search recipes to print" />{!!filter.searchTerm && <GlassPressable onPress={() => filter.setSearchTerm('')} accessibilityLabel="Clear recipe search"><Ionicons name="close-circle" size={18} color={inkFaint} /></GlassPressable>}</GlassSurface>
                <CookbookFilterBar chips={filter.chips} selected={filter.category} onSelect={filter.setCategory} sort={filter.sort} onSortChange={filter.setSort} />
              </>}
              renderItem={({ item: recipe }) => {
                const selection = input.recipes.find((candidate) => candidate.recipeId === recipe.id)!;
                return selection ? <RecipeSelectionRow recipe={recipe} selection={selection} onSelection={patchSelection} /> : null;
              }}
              ListEmptyComponent={<View style={styles.emptyList}><Ionicons name="search-outline" size={28} color={primary} /><Text style={styles.emptyTitle}>No recipes match that</Text><Text style={styles.emptyDetail}>Try another search or cookbook category.</Text></View>}
              ListFooterComponent={<RemovedTray selections={input.recipes} recipes={recipeMap} onRestore={restore} />}
            />}

            {step === 'recipes' && recipeMode === 'arrange' && <DraggableFlatList
              data={included}
              keyExtractor={(selection) => selection.recipeId}
              onDragEnd={({ data }) => reorder(data)}
              activationDistance={14}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.recipeList}
              ListHeaderComponent={<><View style={styles.introBlock}><Text style={styles.eyebrow}>RECIPE ORDER</Text><Text style={styles.stepTitle}>From first page to last</Text><Text style={styles.stepIntro}>Long-press the handle to move a recipe. You can also choose its section and photo treatment.</Text></View><View style={styles.modeTabs}><GlassPressable style={styles.modeTab} onPress={() => setRecipeMode('choose')}><Text style={styles.modeText}>Choose</Text></GlassPressable><GlassPressable style={[styles.modeTab, styles.modeTabOn]} onPress={() => setRecipeMode('arrange')}><Text style={[styles.modeText, styles.modeTextOn]}>Arrange · {included.length}</Text></GlassPressable></View></>}
              renderItem={({ item: selection, drag, isActive }: RenderItemParams<CookbookPrintRecipeSelection>) => {
                const recipe = recipeMap.get(selection.recipeId);
                const photoAllowed = !!recipe?.photoURL
                  && (recipe.photoPrintAllowedByDefault || selection.rightsMode === 'rights-confirmed');
                return <ArrangeRow selection={selection} recipe={recipe} drag={drag} isActive={isActive} photoAllowed={photoAllowed} onPatch={(patch) => patchSelection({ ...selection, ...patch })} onRemove={() => setIncluded(selection.recipeId, false)} />;
              }}
              ListEmptyComponent={<View style={styles.emptyList}><Text style={styles.emptyTitle}>Choose a recipe first</Text><GlassPressable style={styles.secondaryWide} onPress={() => setRecipeMode('choose')}><Text style={styles.secondaryWideText}>Browse your cookbook</Text></GlassPressable></View>}
              ListFooterComponent={<RemovedTray selections={input.recipes} recipes={recipeMap} onRestore={restore} />}
            />}

            {step === 'design' && <DesignStep input={input} recipes={eligibility.recipes} onInput={setWorking} />}
            {step === 'preview' && <><PreviewStep preview={preview} current={previewCurrent} loading={previewing} onGenerate={generatePreview} />{!!previewError && <View style={styles.floatingError}><Text style={styles.inlineError}>{previewError}</Text><GlassPressable onPress={generatePreview}><Text style={styles.retryText}>Try again</Text></GlassPressable></View>}</>}
            {step === 'checkout' && <CheckoutStep address={address} onAddress={setAddress} quote={quote} quoting={quoting} quoteError={quoteError} onQuote={requestQuote} acknowledgements={acks} onAcknowledgements={setAcks} paying={paying} paymentError={paymentError} pendingOrderId={pendingOrderId} onPay={pay} onOpenOrder={openOrder} />}
          </View>

          {step !== 'checkout' && <View style={styles.footer}>
            {saveState === 'error' && <GlassPressable style={styles.saveRetry} onPress={() => { void persistNow().catch(() => {}); }}><Ionicons name="cloud-upload-outline" size={17} color="#A94E48" /><Text style={styles.saveRetryText}>Retry save</Text></GlassPressable>}
            <View style={{ flex: 1 }} />
            <GlassPressable style={styles.continueButton} onPress={() => { void continueStep(); }} disabled={previewing}>
              <Text style={styles.continueText}>{step === 'preview' ? 'Continue to delivery' : 'Continue'}</Text><Ionicons name="arrow-forward" size={18} color="#fff" />
            </GlassPressable>
          </View>}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 34, gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 12, paddingBottom: 10, gap: 13 },
  headerButton: { width: 43, height: 43, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.78)', borderWidth: 1, borderColor: '#fff' },
  headerCopy: { flex: 1 },
  headerEyebrow: { fontSize: 10, lineHeight: 14, letterSpacing: 1.35, fontWeight: '800', color: ink },
  saveRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  saveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: primary },
  saveDotSaving: { backgroundColor: '#B9A56E' },
  saveDotError: { backgroundColor: '#A94E48' },
  saveText: { fontSize: 11, color: inkMuted },
  steps: { flexDirection: 'row', paddingHorizontal: 23, paddingBottom: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: hairline },
  stepItem: { flex: 1, alignItems: 'center', gap: 5 },
  stepIcon: { width: 27, height: 27, borderRadius: 14, backgroundColor: '#E3E9E0', alignItems: 'center', justifyContent: 'center' },
  stepIconOn: { backgroundColor: primary },
  stepLabel: { fontSize: 10, color: inkFaint, fontWeight: '600' },
  stepLabelOn: { color: ink, fontWeight: '800' },
  body: { flex: 1 },
  recipeList: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 34 },
  formContent: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 42 },
  introBlock: { marginBottom: 20 },
  eyebrow: { fontSize: 9, fontWeight: '800', letterSpacing: 1.7, color: primary, marginBottom: 7 },
  stepTitle: { fontSize: 28, lineHeight: 34, letterSpacing: -0.9, fontWeight: '700', color: ink },
  stepIntro: { fontSize: 14, lineHeight: 21, color: inkMuted, marginTop: 7 },
  modeTabs: { flexDirection: 'row', backgroundColor: '#E7ECE4', borderRadius: 20, padding: 4, marginBottom: 15 },
  modeTab: { flex: 1, minHeight: 39, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  modeTabOn: { backgroundColor: '#fff' },
  modeText: { fontSize: 13, fontWeight: '600', color: inkMuted },
  modeTextOn: { color: primary, fontWeight: '800' },
  searchBox: { minHeight: 51, borderRadius: 23, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 13 },
  searchInput: { flex: 1, color: ink, fontSize: 15, paddingVertical: 12 },
  recipeChoice: { borderRadius: 25, padding: 10, marginBottom: 11 },
  recipeChoiceSelected: { borderColor: '#B8D7C4', backgroundColor: 'rgba(244,251,245,0.82)' },
  recipeChoiceTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  recipeThumb: { width: 72, height: 77, borderRadius: 18, backgroundColor: mint },
  recipeThumbEmpty: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  recipeChoiceCopy: { flex: 1 },
  recipeEyebrow: { color: primary, fontSize: 9, letterSpacing: 1.1, fontWeight: '800', textTransform: 'uppercase', marginBottom: 5 },
  recipeChoiceTitle: { color: ink, fontSize: 17, lineHeight: 21, fontWeight: '700', letterSpacing: -0.35 },
  recipeMeta: { color: inkMuted, fontSize: 11, marginTop: 5 },
  selectButton: { width: 37, height: 37, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E4EEE4', borderWidth: 1, borderColor: '#D1E0D2' },
  selectButtonOn: { backgroundColor: primary, borderColor: primary },
  rightsPanel: { marginTop: 10, padding: 13, backgroundColor: '#F5EDDF', borderRadius: 18 },
  warningHeading: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  warningTitle: { flex: 1, color: '#73522B', fontSize: 12, fontWeight: '800' },
  warningText: { color: '#7A674D', fontSize: 11, lineHeight: 17, marginTop: 6 },
  rightsChoices: { flexDirection: 'row', gap: 7, marginTop: 11 },
  rightsChoice: { flex: 1, minHeight: 36, borderRadius: 14, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 1, borderColor: '#E3D5BE' },
  rightsChoiceOn: { backgroundColor: primary, borderColor: primary },
  rightsChoiceText: { color: '#73522B', fontSize: 10, fontWeight: '700', textAlign: 'center' },
  rightsChoiceTextOn: { color: '#fff' },
  notesInput: { minHeight: 65, backgroundColor: 'rgba(255,255,255,0.75)', borderRadius: 14, marginTop: 9, padding: 11, color: ink, fontSize: 12, lineHeight: 17, textAlignVertical: 'top' },
  smallWarning: { flexDirection: 'row', gap: 7, alignItems: 'center', marginTop: 9, paddingHorizontal: 6 },
  smallWarningText: { flex: 1, color: '#7A674D', fontSize: 11, lineHeight: 16 },
  arrangeCard: { flexDirection: 'row', alignItems: 'flex-start', borderRadius: 24, padding: 10, gap: 9, marginBottom: 10 },
  arrangeCardActive: { borderColor: primary, shadowOpacity: 0.16 },
  dragHandle: { width: 31, minHeight: 66, alignItems: 'center', justifyContent: 'center' },
  arrangeThumb: { width: 58, height: 66, borderRadius: 16, backgroundColor: mint },
  arrangeCopy: { flex: 1, paddingTop: 2 },
  arrangeTitle: { fontSize: 15, lineHeight: 19, fontWeight: '700', color: ink },
  sectionInput: { minHeight: 31, borderBottomWidth: 1, borderBottomColor: hairline, color: inkMuted, fontSize: 11, paddingVertical: 5, marginTop: 4 },
  placementRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 8 },
  placementChip: { minHeight: 27, borderRadius: 13, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E7ECE4' },
  placementChipOn: { backgroundColor: primary },
  placementText: { color: inkMuted, fontSize: 9, fontWeight: '700' },
  placementTextOn: { color: '#fff' },
  arrangePhotoNote: { color: '#8A6740', fontSize: 9, lineHeight: 14, marginTop: 6 },
  removeRecipe: { width: 31, height: 31, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E9EEE7' },
  removedTray: { marginTop: 22, paddingTop: 18, borderTopWidth: 1, borderTopColor: hairline },
  removedHeading: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  removedTitle: { color: ink, fontSize: 15, fontWeight: '700' },
  removedCount: { color: inkFaint, fontSize: 11 },
  removedDetail: { color: inkMuted, fontSize: 11, lineHeight: 17, marginTop: 5 },
  removedWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 11 },
  restoreChip: { maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, minHeight: 34, borderRadius: 17, backgroundColor: '#E5EFE6' },
  restoreText: { maxWidth: 210, color: primary, fontSize: 11, fontWeight: '700' },
  emptyList: { alignItems: 'center', paddingVertical: 38, paddingHorizontal: 25 },
  emptyTitle: { color: ink, fontSize: 20, fontWeight: '700', marginTop: 10 },
  emptyDetail: { color: inkMuted, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 7 },
  formCard: { borderRadius: 27, padding: 18, marginBottom: 23 },
  formCardTitle: { color: ink, fontSize: 19, fontWeight: '700', letterSpacing: -0.45, marginBottom: 14 },
  field: { marginBottom: 15 },
  fieldLabel: { color: inkMuted, fontSize: 11, fontWeight: '700', marginBottom: 6 },
  fieldInput: { minHeight: 48, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.83)', borderWidth: 1, borderColor: '#E2E8DE', paddingHorizontal: 14, color: ink, fontSize: 15 },
  fieldInputMultiline: { minHeight: 92, paddingTop: 13, paddingBottom: 13, lineHeight: 21 },
  sectionHeading: { marginTop: 3, marginBottom: 13 },
  sectionHeadingTitle: { color: ink, fontSize: 20, fontWeight: '700', letterSpacing: -0.5 },
  sectionHeadingDetail: { color: inkMuted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  coverChoices: { gap: 10, paddingBottom: 19 },
  coverChoice: { width: 118, padding: 7, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.74)', borderWidth: 1, borderColor: '#fff' },
  coverChoiceOn: { borderColor: primary, borderWidth: 2, padding: 6 },
  coverChoiceImage: { width: '100%', height: 126, borderRadius: 16, backgroundColor: mint },
  coverChoiceText: { color: ink, fontSize: 11, lineHeight: 15, fontWeight: '700', margin: 7 },
  coverChoiceCheck: { position: 'absolute', right: 12, top: 12, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: primary, borderWidth: 2, borderColor: '#fff' },
  noCoverPhoto: { borderRadius: 23, padding: 18, alignItems: 'center', marginBottom: 19 },
  noCoverTitle: { color: ink, fontWeight: '700', fontSize: 15, marginTop: 9 },
  noCoverText: { color: inkMuted, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 5 },
  cropCard: { borderRadius: 27, padding: 12, flexDirection: 'row', gap: 13, marginBottom: 23, overflow: 'hidden' },
  cropPreview: { width: 145, height: 188, borderRadius: 19, backgroundColor: mint, overflow: 'hidden', justifyContent: 'flex-end' },
  cropImage: { ...StyleSheet.absoluteFillObject, width: 145, height: 188 },
  cropShadeTop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(13,34,26,0.19)' },
  cropTitlePreview: { padding: 13 },
  cropTitleText: { color: '#fff', fontSize: 18, lineHeight: 20, fontWeight: '800', letterSpacing: -0.55 },
  cropBylineText: { color: 'rgba(255,255,255,0.88)', fontSize: 9, marginTop: 7 },
  cropControls: { flex: 1, justifyContent: 'center' },
  cropLabel: { color: inkMuted, fontSize: 10, fontWeight: '700', textAlign: 'center', marginVertical: 5 },
  cropPad: { width: 114, alignSelf: 'center', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  cropButton: { width: 38, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: '#E8EDE5' },
  cropCenter: { width: 38, height: 34, borderRadius: 12, backgroundColor: '#D6E6D7' },
  zoomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  zoomButton: { width: 32, height: 32, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E8EDE5' },
  zoomValue: { width: 43, color: ink, fontSize: 11, fontWeight: '700', textAlign: 'center' },
  themeGrid: { gap: 10, marginBottom: 24 },
  themeCard: { minHeight: 133, borderRadius: 25, padding: 12, paddingLeft: 117, backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 1, borderColor: '#fff', justifyContent: 'center' },
  themePage: { position: 'absolute', left: 12, top: 12, bottom: 12, width: 90, borderRadius: 13, padding: 9, backgroundColor: '#F6EFE3', borderWidth: 1, borderColor: '#E9DECC' },
  themePage_classic: { backgroundColor: '#F6EFE3' },
  themePage_modern: { backgroundColor: '#EDF4EF' },
  themePage_photo_forward: { backgroundColor: '#EEE9E2' },
  themePhoto: { height: 39, backgroundColor: '#9DB7A3', borderRadius: 7, marginBottom: 7 },
  themeLine: { height: 4, backgroundColor: ink, borderRadius: 2, marginBottom: 4 },
  themeColumns: { flexDirection: 'row', gap: 4, marginTop: 3, flex: 1 },
  themeColumn: { flex: 1, backgroundColor: 'rgba(23,63,53,0.12)', borderRadius: 2 },
  optionSelected: { borderColor: primary, borderWidth: 2 },
  optionTitle: { color: ink, fontSize: 16, fontWeight: '700' },
  optionDetail: { color: inkMuted, fontSize: 11, lineHeight: 17, marginTop: 5 },
  optionCheck: { position: 'absolute', right: 12, top: 12, width: 22, height: 22, borderRadius: 11, backgroundColor: primary, alignItems: 'center', justifyContent: 'center' },
  skuGrid: { gap: 9, marginBottom: 23 },
  skuCard: { minHeight: 92, borderRadius: 24, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 1, borderColor: '#fff' },
  skuIcon: { width: 49, height: 49, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: mint },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, paddingVertical: 11 },
  checkbox: { width: 23, height: 23, borderRadius: 8, borderWidth: 1.5, borderColor: '#BCCBBC', alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  checkboxChecked: { backgroundColor: primary, borderColor: primary },
  checkTitle: { color: ink, fontSize: 14, lineHeight: 19, fontWeight: '700' },
  checkDetail: { color: inkMuted, fontSize: 11, lineHeight: 17, marginTop: 3 },
  previewContent: { paddingTop: 20, paddingBottom: 40 },
  staleBanner: { marginHorizontal: 20, marginBottom: 15, padding: 13, borderRadius: 19, backgroundColor: '#F5EDDF', flexDirection: 'row', alignItems: 'center', gap: 9 },
  staleTitle: { color: '#73522B', fontSize: 13, fontWeight: '800' },
  staleText: { color: '#7A674D', fontSize: 10, lineHeight: 15, marginTop: 2 },
  regenerateSmall: { paddingHorizontal: 12, minHeight: 34, borderRadius: 16, justifyContent: 'center', backgroundColor: '#fff' },
  regenerateText: { color: '#73522B', fontSize: 11, fontWeight: '800' },
  previewSummary: { paddingHorizontal: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  previewCount: { color: ink, fontSize: 25, fontWeight: '700', letterSpacing: -0.7 },
  spinePill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#E3EDE3', borderRadius: 17, paddingHorizontal: 11, minHeight: 34 },
  spineText: { color: primary, fontSize: 10, fontWeight: '700' },
  pageRail: { paddingHorizontal: 20, gap: 14 },
  pageCard: { aspectRatio: 8.5 / 11, borderRadius: 23, backgroundColor: '#fff', overflow: 'hidden', borderWidth: 1, borderColor: '#E2E7DF', shadowColor: ink, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 3 },
  pageImage: { flex: 1, backgroundColor: '#fff' },
  pageUnavailable: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  pageUnavailableTitle: { color: ink, fontSize: 15, fontWeight: '700', marginTop: 9 },
  pageUnavailableText: { color: inkMuted, fontSize: 11, marginTop: 4, textAlign: 'center' },
  pageCaption: { height: 44, paddingHorizontal: 13, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hairline, flexDirection: 'row', alignItems: 'center', gap: 8 },
  pageNumber: { color: primary, fontSize: 8, letterSpacing: 1.1, fontWeight: '800' },
  pageLabel: { flex: 1, color: inkMuted, fontSize: 10 },
  swipeHint: { color: inkFaint, fontSize: 11, textAlign: 'center', marginTop: 12 },
  preflightCard: { marginHorizontal: 20, marginTop: 22, borderRadius: 27, padding: 17 },
  preflightHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  preflightDetail: { color: inkMuted, fontSize: 11, marginTop: -8, marginBottom: 6 },
  issueRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hairline },
  issueSeverity: { fontSize: 8, letterSpacing: 1.1, fontWeight: '800', marginBottom: 3 },
  issueMessage: { color: ink, fontSize: 12, lineHeight: 18 },
  allClear: { flexDirection: 'row', gap: 9, backgroundColor: '#E8F1E7', borderRadius: 17, padding: 13 },
  allClearText: { flex: 1, color: inkMuted, fontSize: 11, lineHeight: 17 },
  secondaryWide: { marginHorizontal: 20, marginTop: 14, minHeight: 48, borderRadius: 21, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E5EFE6', borderWidth: 1, borderColor: '#D4E3D5' },
  secondaryWideText: { color: primary, fontSize: 13, fontWeight: '800' },
  loadingTitle: { color: ink, fontSize: 21, lineHeight: 27, fontWeight: '700', textAlign: 'center', marginTop: 5 },
  loadingDetail: { color: inkMuted, fontSize: 13, lineHeight: 20, textAlign: 'center', maxWidth: 330 },
  largeIcon: { width: 72, height: 72, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: mint },
  primaryButton: { marginTop: 10, minHeight: 49, borderRadius: 21, paddingHorizontal: 21, backgroundColor: primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  primaryButtonText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  textButton: { padding: 12 },
  textButtonText: { color: primary, fontSize: 13, fontWeight: '700' },
  floatingError: { position: 'absolute', left: 20, right: 20, bottom: 12, borderRadius: 17, padding: 13, backgroundColor: '#F8E8E5', flexDirection: 'row', alignItems: 'center', gap: 8 },
  inlineError: { flex: 1, color: '#A94E48', fontSize: 11, lineHeight: 17, marginTop: 8 },
  retryText: { color: '#A94E48', fontSize: 12, fontWeight: '800' },
  twoFields: { flexDirection: 'row', gap: 10 },
  quoteButton: { minHeight: 49, borderRadius: 20, backgroundColor: primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 2 },
  quoteCard: { borderRadius: 27, padding: 18, marginBottom: 22 },
  quoteHeading: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, marginBottom: 16 },
  quoteMethod: { color: ink, fontSize: 17, fontWeight: '700' },
  quoteExpiry: { color: inkFaint, fontSize: 9, textAlign: 'right', maxWidth: 100 },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  priceLabel: { color: inkMuted, fontSize: 13 },
  priceValue: { color: ink, fontSize: 13, fontWeight: '600' },
  totalRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: hairline, marginTop: 9, paddingTop: 14 },
  totalLabel: { color: ink, fontSize: 17, fontWeight: '800' },
  currencyLabel: { color: inkFaint, fontSize: 9, marginTop: 2 },
  totalValue: { color: ink, fontSize: 25, fontWeight: '800', letterSpacing: -0.7 },
  estimateBox: { flexDirection: 'row', gap: 9, padding: 12, borderRadius: 16, backgroundColor: '#E8F1E7', marginTop: 15 },
  estimateText: { color: inkMuted, fontSize: 11, lineHeight: 17 },
  consentCard: { borderRadius: 27, padding: 18, marginBottom: 20 },
  paymentError: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: 19, backgroundColor: '#F8E8E5', marginBottom: 15 },
  paymentErrorTitle: { color: '#843F3A', fontSize: 13, fontWeight: '800' },
  paymentErrorText: { color: '#895B57', fontSize: 11, lineHeight: 17, marginTop: 3 },
  pendingOrderButton: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 9, alignSelf: 'flex-start' },
  pendingOrderText: { color: primary, fontSize: 11, fontWeight: '800' },
  payButton: { minHeight: 55, borderRadius: 23, backgroundColor: primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  payButtonText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  secureNote: { flexDirection: 'row', gap: 8, padding: 14, alignItems: 'flex-start' },
  secureText: { flex: 1, color: inkMuted, fontSize: 10, lineHeight: 16 },
  footer: { minHeight: 72, paddingHorizontal: 18, paddingTop: 10, paddingBottom: Platform.OS === 'android' ? 14 : 8, flexDirection: 'row', alignItems: 'flex-start', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hairline, backgroundColor: 'rgba(245,245,239,0.96)' },
  continueButton: { minHeight: 48, borderRadius: 21, backgroundColor: primary, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  continueText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  saveRetry: { minHeight: 43, borderRadius: 18, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#F8E8E5' },
  saveRetryText: { color: '#A94E48', fontSize: 11, fontWeight: '800' },
});
