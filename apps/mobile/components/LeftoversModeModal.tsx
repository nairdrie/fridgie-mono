import Ionicons from '@expo/vector-icons/Ionicons';
import * as FileSystem from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import uuid from 'react-native-uuid';

import { GlassPressable, GlassSurface } from '@/components/ui/Glass';
import { PRO_CONFIG } from '@/constants/pro';
import { ApiError, identifyLeftovers, type DetectedLeftoversIngredient } from '@/utils/api';
import {
  cleanupOwnedLeftoversUris,
  isOwnedLeftoversCacheUri,
  LEFTOVERS_MAX_IMAGE_EDGE,
  LeftoversOperationTracker,
  type LeftoversPhoto,
  leftoversAttemptRateMessage,
  leftoversScanNotice,
  leftoversScanUsageFromBody,
  leftoversResizeActions,
  moveLeftoversPhoto,
  photoRejectionMessage,
  prepareLeftoversPhotos,
} from '@/utils/leftovers';
import {
  isCurrentUsageWindowExhausted,
  isSecureWebUrl,
  quotaGateAfterRefresh,
  type AccountStatus,
  type AiUsage,
} from '@/utils/pro';
import { ink, inkMuted, primary } from '@/utils/styles';
import {
  MAX_LEFTOVERS_INGREDIENTS,
  MAX_LEFTOVERS_PHOTOS,
  normalizeLeftoversIngredients,
} from '@fridgie/shared/leftovers';

interface LeftoversModeModalProps {
  visible: boolean;
  onClose: () => void;
  onConfirm: (ingredients: string[]) => void | Promise<void>;
  /** Called if the server says the locally cached entitlement is no longer valid. */
  onRequirePro: () => void;
  /** Server-authoritative weekly Leftovers Mode allowance snapshot. */
  scanUsage?: AiUsage | null;
  /** Lets the parent refresh its broader account-status snapshot in the background. */
  onScanUsageChanged?: () => void;
  /** Fresh preflight used only when a cached zero could include a refunded reservation. */
  onRefreshAccountStatus?: () => Promise<AccountStatus | null>;
}

interface EditableIngredient extends DetectedLeftoversIngredient {
  id: string;
}

type Stage = 'photos' | 'confirm';

// The picker creates a local source copy, then ImageManipulator applies the
// actual privacy/payload boundary and gives us a cache file that we own.
const PICKER_QUALITY = 0.85;
const LEFTOVERS_JPEG_QUALITY = 0.72;

async function cleanupLeftoversFiles(ownedUris: (string | null | undefined)[]): Promise<void> {
  const failures = await cleanupOwnedLeftoversUris(
    ownedUris,
    uri => FileSystem.deleteAsync(uri, { idempotent: true }),
  );
  if (failures) console.warn(`Could not clean up ${failures} Leftovers Mode temporary file(s).`);
}

function notifyScanUsageChanged(callback?: () => void): void {
  if (!callback) return;
  void Promise.resolve().then(callback).catch(() => {
    console.warn('Could not refresh the account scan allowance after a Leftovers Mode response.');
  });
}

function pickerFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('MISSING_ACTIVITY_TO_HANDLE_INTENT') || message.includes('CAMERA_UNAVAILABLE')) {
    return "This device doesn't have a camera app Fridgie can open. You can still choose photos from your library.";
  }
  return 'Please try again, or choose the other photo source.';
}

export default function LeftoversModeModal({
  visible,
  onClose,
  onConfirm,
  onRequirePro,
  scanUsage,
  onScanUsageChanged,
  onRefreshAccountStatus,
}: LeftoversModeModalProps) {
  const hasPrivacyUrl = isSecureWebUrl(PRO_CONFIG.privacyUrl);
  const insets = useSafeAreaInsets();
  const [stage, setStage] = useState<Stage>('photos');
  const [photos, setPhotos] = useState<LeftoversPhoto[]>([]);
  const [ingredients, setIngredients] = useState<EditableIngredient[]>([]);
  const [isPicking, setIsPicking] = useState(false);
  const [isIdentifying, setIsIdentifying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [displayedScanUsage, setDisplayedScanUsage] = useState<AiUsage | null>(scanUsage ?? null);
  const operations = useRef(new LeftoversOperationTracker()).current;
  const photosRef = useRef<LeftoversPhoto[]>([]);
  const identifyAbortRef = useRef<AbortController | null>(null);
  photosRef.current = photos;

  useEffect(() => {
    // Every open is a new session. Late picker/identify completions from the
    // prior session must not repopulate a reopened modal.
    operations.invalidate();
    identifyAbortRef.current?.abort();
    identifyAbortRef.current = null;
    const stalePhotos = photosRef.current;
    photosRef.current = [];
    if (stalePhotos.length) void cleanupLeftoversFiles(stalePhotos.map(photo => photo.ownedUri));
    setStage('photos');
    setPhotos([]);
    setIngredients([]);
    setIsPicking(false);
    setIsIdentifying(false);
    setNotice(null);
    setError(null);
    if (!visible) return undefined;

    return () => {
      operations.invalidate();
      identifyAbortRef.current?.abort();
      identifyAbortRef.current = null;
      const currentPhotos = photosRef.current;
      photosRef.current = [];
      if (currentPhotos.length) void cleanupLeftoversFiles(currentPhotos.map(photo => photo.ownedUri));
    };
  }, [operations, visible]);

  useEffect(() => {
    if (visible) setDisplayedScanUsage(scanUsage ?? null);
  }, [scanUsage, visible]);

  const usableIngredients = useMemo(
    () => normalizeLeftoversIngredients(ingredients.map(item => item.name)),
    [ingredients],
  );
  const scanNotice = useMemo(
    () => displayedScanUsage ? leftoversScanNotice(displayedScanUsage) : null,
    [displayedScanUsage],
  );
  const knownScanExhausted = isCurrentUsageWindowExhausted(displayedScanUsage);

  const close = () => {
    operations.invalidate();
    identifyAbortRef.current?.abort();
    identifyAbortRef.current = null;
    const currentPhotos = photosRef.current;
    photosRef.current = [];
    if (currentPhotos.length) void cleanupLeftoversFiles(currentPhotos.map(photo => photo.ownedUri));
    // Data URLs can be several megabytes each. Drop them immediately instead
    // of retaining private source photos behind a closed nested modal.
    setPhotos([]);
    setIngredients([]);
    setIsPicking(false);
    setIsIdentifying(false);
    setNotice(null);
    setError(null);
    onClose();
  };

  const cameraDenied = (canAskAgain: boolean) => Alert.alert(
    'Camera access needed',
    canAskAgain
      ? 'Fridgie needs camera access to photograph your fridge or pantry.'
      : 'Camera access is off. You can turn it on in Settings, or choose existing photos instead.',
    canAskAgain
      ? [{ text: 'OK' }]
      : [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open Settings', onPress: () => { void Linking.openSettings(); } },
        ],
  );

  const pickPhotos = async (source: 'camera' | 'library') => {
    if (isPicking || isIdentifying) return;
    const remaining = MAX_LEFTOVERS_PHOTOS - photosRef.current.length;
    if (remaining <= 0) {
      Alert.alert('Photo limit reached', `You can check up to ${MAX_LEFTOVERS_PHOTOS} photos at once. Remove one to add another.`);
      return;
    }
    const operation = operations.start();
    if (operation === null) return;

    setError(null);
    setNotice(null);
    setIsPicking(true);
    const createdOwnedUris: string[] = [];
    try {
      if (source === 'camera') {
        let permission = await ImagePicker.getCameraPermissionsAsync();
        if (!operations.isCurrent(operation)) return;
        // On Android, launchCameraAsync owns the actual request. Asking here as
        // well can overlap two activity permission requests. iOS only checks at
        // launch, so it must be requested explicitly there.
        if (!permission.granted && permission.canAskAgain && Platform.OS !== 'android') {
          permission = await ImagePicker.requestCameraPermissionsAsync();
          if (!operations.isCurrent(operation)) return;
        }
        if (!permission.granted && !permission.canAskAgain) {
          cameraDenied(false);
          return;
        }
        if (!permission.granted && Platform.OS !== 'android') {
          cameraDenied(true);
          return;
        }
      }

      const common: ImagePicker.ImagePickerOptions = {
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: PICKER_QUALITY,
        // Reading base64 here would materialize the full camera original in JS.
        // Only the bounded ImageManipulator output is encoded below.
        base64: false,
      };
      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync(common)
        : await ImagePicker.launchImageLibraryAsync({
            ...common,
            allowsMultipleSelection: true,
            selectionLimit: remaining,
            orderedSelection: true,
          });
      if (!operations.isCurrent(operation) || result.canceled) return;

      const processedAssets: {
        uri: string;
        ownedUri: string;
        base64?: string | null;
      }[] = [];
      let preprocessingFailures = 0;

      // Process sequentially to bound native/JS memory while several camera
      // images are selected. Every result URI is a disposable app cache file.
      for (const asset of result.assets ?? []) {
        if (!operations.isCurrent(operation)) {
          await cleanupLeftoversFiles(createdOwnedUris);
          return;
        }
        const actions = asset.uri
          ? leftoversResizeActions(asset.width, asset.height, LEFTOVERS_MAX_IMAGE_EDGE)
          : null;
        if (!asset.uri || actions === null) {
          preprocessingFailures += 1;
          continue;
        }

        try {
          const processed = await manipulateAsync(asset.uri, actions, {
            compress: LEFTOVERS_JPEG_QUALITY,
            format: SaveFormat.JPEG,
            base64: true,
          });
          if (!isOwnedLeftoversCacheUri(asset.uri, processed.uri, FileSystem.cacheDirectory)) {
            preprocessingFailures += 1;
            console.warn('ImageManipulator returned a Leftovers Mode photo outside the app cache.');
            continue;
          }
          createdOwnedUris.push(processed.uri);
          if (!operations.isCurrent(operation)) {
            await cleanupLeftoversFiles(createdOwnedUris);
            return;
          }
          processedAssets.push({
            uri: processed.uri,
            ownedUri: processed.uri,
            base64: processed.base64,
          });
        } catch (processingError) {
          preprocessingFailures += 1;
          console.warn(
            'Could not prepare one Leftovers Mode photo:',
            processingError instanceof Error ? processingError.name : 'unknown error',
          );
        }
      }

      if (!operations.isCurrent(operation)) {
        await cleanupLeftoversFiles(createdOwnedUris);
        return;
      }

      const prepared = prepareLeftoversPhotos(processedAssets, photosRef.current, () => String(uuid.v4()));
      const nextPhotos = [...photosRef.current, ...prepared.accepted];
      photosRef.current = nextPhotos;
      if (prepared.accepted.length) setPhotos(nextPhotos);
      if (prepared.discardedOwnedUris.length) {
        void cleanupLeftoversFiles(prepared.discardedOwnedUris);
      }
      const partial = photoRejectionMessage({
        ...prepared.rejected,
        missingData: prepared.rejected.missingData + preprocessingFailures,
      });
      if (partial) setNotice(partial);
    } catch (pickerError) {
      if (createdOwnedUris.length) await cleanupLeftoversFiles(createdOwnedUris);
      if (!operations.isCurrent(operation)) return;
      console.error(`Could not open the leftovers ${source}:`, pickerError);
      const failure = pickerError instanceof Error ? pickerError.message : String(pickerError ?? '');
      if (failure.includes('USER_REJECTED_PERMISSIONS')) {
        const permission = await ImagePicker.getCameraPermissionsAsync().catch(() => null);
        if (!operations.isCurrent(operation)) return;
        cameraDenied(permission?.canAskAgain ?? false);
      } else {
        Alert.alert(source === 'camera' ? "Couldn't open the camera" : "Couldn't open your photos", pickerFailureMessage(pickerError));
      }
    } finally {
      if (operations.finish(operation)) setIsPicking(false);
    }
  };

  const identify = async () => {
    if (!photosRef.current.length || isIdentifying || isPicking) return;
    const operation = operations.start();
    if (operation === null) return;
    // Snapshot this session before the first await. Closing invalidates the
    // token, and a reopened session can never be submitted by this handler.
    const photosForScan = [...photosRef.current];
    let abortController: AbortController | null = null;
    setIsIdentifying(true);
    setError(null);
    setNotice(null);
    try {
      if (knownScanExhausted) {
        const refreshed = await onRefreshAccountStatus?.().catch(() => null) ?? null;
        if (!operations.isCurrent(operation)) return;
        const decision = quotaGateAfterRefresh(refreshed, 'leftovers');
        if (decision.kind === 'pro-required') {
          close();
          onRequirePro();
          return;
        }
        if (refreshed?.leftoversScanUsage) {
          setDisplayedScanUsage(refreshed.leftoversScanUsage);
        }
        if (decision.kind === 'quota-exhausted') {
          const currentNotice = leftoversScanNotice(decision.usage);
          setError(`Your weekly Leftovers Mode scan allowance is used up. ${currentNotice.reset}.`);
          return;
        }
        // `null` means the refresh failed, not that the old zero was confirmed.
        // Continue and let the scan endpoint resolve refunded reservations.
      }
      if (!operations.isCurrent(operation)) return;
      abortController = new AbortController();
      identifyAbortRef.current = abortController;
      const response = await identifyLeftovers(
        photosForScan.map(photo => photo.dataUrl),
        abortController.signal,
      );
      if (!operations.isCurrent(operation)) return;
      const responseScanUsage = leftoversScanUsageFromBody(response);
      if (responseScanUsage) {
        setDisplayedScanUsage(responseScanUsage);
        notifyScanUsageChanged(onScanUsageChanged);
      }

      // The retryable phase is over once the server answered successfully.
      // Delete the owned cache files before exposing the editable draft.
      await cleanupLeftoversFiles(photosForScan.map(photo => photo.ownedUri));
      if (!operations.isCurrent(operation)) return;
      photosRef.current = [];
      setIngredients(response.ingredients.map(item => ({ ...item, id: String(uuid.v4()) })));
      setNotice(response.warnings.length ? response.warnings.join(' ') : null);
      setPhotos([]);
      setStage('confirm');
    } catch (identifyError) {
      if (!operations.isCurrent(operation)) return;
      const rejectedScanUsage = identifyError instanceof ApiError && identifyError.status === 429
        ? leftoversScanUsageFromBody(identifyError.data)
        : null;
      if (rejectedScanUsage) {
        setDisplayedScanUsage(rejectedScanUsage);
        notifyScanUsageChanged(onScanUsageChanged);
      }
      console.error('Could not identify leftovers:', identifyError);
      if (identifyError instanceof ApiError && identifyError.status === 403) {
        close();
        onRequirePro();
        return;
      }
      if (identifyError instanceof ApiError && identifyError.status === 413) {
        setError('Those photos are too large together. Remove one and try again.');
      } else if (identifyError instanceof ApiError && identifyError.code === 'leftovers_scan_busy') {
        setError('Another scan is already in progress. Wait for it to finish, then try again.');
      } else if (identifyError instanceof ApiError && identifyError.code === 'leftovers_attempt_rate_exceeded') {
        setError(leftoversAttemptRateMessage(identifyError.data));
      } else if (identifyError instanceof ApiError && identifyError.code === 'leftovers_scan_limit') {
        const reset = rejectedScanUsage
          ? leftoversScanNotice(rejectedScanUsage).reset
          : displayedScanUsage
            ? leftoversScanNotice(displayedScanUsage).reset
            : 'Reset time unavailable';
        setError(`Your weekly Leftovers Mode scan allowance is used up. ${reset}.`);
      } else if (identifyError instanceof ApiError && [400, 422, 503].includes(identifyError.status)) {
        setError(identifyError.message);
      } else {
        setError("We couldn't check those photos. They weren't saved, and you can try again.");
      }
    } finally {
      if (abortController && identifyAbortRef.current === abortController) identifyAbortRef.current = null;
      if (operations.finish(operation)) setIsIdentifying(false);
    }
  };

  const movePhoto = (index: number, direction: -1 | 1) => {
    const nextPhotos = moveLeftoversPhoto(photosRef.current, index, direction);
    photosRef.current = nextPhotos;
    setPhotos(nextPhotos);
  };

  const removePhoto = (photo: LeftoversPhoto) => {
    const nextPhotos = photosRef.current.filter(item => item.id !== photo.id);
    photosRef.current = nextPhotos;
    setPhotos(nextPhotos);
    // `ownedUri` is always an ImageManipulator cache result. Never delete the
    // picker URI supplied by the user's photo library or camera provider.
    void cleanupLeftoversFiles([photo.ownedUri]);
  };

  const updateIngredient = (id: string, name: string) =>
    setIngredients(current => current.map(item => item.id === id ? { ...item, name } : item));

  const removeIngredient = (id: string) =>
    setIngredients(current => current.filter(item => item.id !== id));

  const addIngredient = () => setIngredients(current => current.length >= MAX_LEFTOVERS_INGREDIENTS
    ? current
    : [...current, { id: String(uuid.v4()), name: '', confidence: 'high' }]);

  const confirm = async () => {
    if (!usableIngredients.length || isIdentifying) return;
    setIsIdentifying(true);
    try {
      await onConfirm(usableIngredients);
      close();
    } finally {
      setIsIdentifying(false);
    }
  };

  if (!visible) return null;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.screen, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 12) }]}
      accessibilityViewIsModal
    >
        <GlassSurface style={styles.header} intensity={70}>
          {stage === 'confirm' ? (
            <GlassPressable
              onPress={() => { setStage('photos'); setIngredients([]); setNotice(null); }}
              style={styles.headerButton}
              accessibilityLabel="Back to photos"
            >
              <Ionicons name="arrow-back" size={21} color={ink} />
            </GlassPressable>
          ) : <View style={styles.headerButton} />}
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>FRIDGIE PRO</Text>
            <Text style={styles.headerTitle}>Leftovers Mode</Text>
          </View>
          <GlassPressable onPress={close} style={styles.headerButton} accessibilityLabel="Close Leftovers Mode">
            <Ionicons name="close" size={21} color={ink} />
          </GlassPressable>
        </GlassSurface>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {stage === 'photos' ? (
            <>
              <View style={styles.heroIcon}><Ionicons name="camera-outline" size={32} color={primary} /></View>
              <Text style={styles.title}>Show us what you have</Text>
              <Text style={styles.subtitle}>
                Add a few fridge or pantry angles. We’ll draft an ingredient list for you to check before suggesting anything.
              </Text>

              {!!scanNotice && (
                <View
                  style={[
                    styles.scanUsageCard,
                    scanNotice.level === 'low' && styles.scanUsageLow,
                    scanNotice.level === 'critical' && styles.scanUsageCritical,
                    scanNotice.level === 'exhausted' && styles.scanUsageExhausted,
                  ]}
                  accessible
                  accessibilityRole={scanNotice.level === 'normal' ? 'text' : 'alert'}
                  accessibilityLabel={`${scanNotice.title}. ${scanNotice.reset}.`}
                >
                  <Ionicons
                    name={scanNotice.level === 'exhausted' ? 'alert-circle-outline' : 'time-outline'}
                    size={19}
                    color={scanNotice.level === 'exhausted'
                      ? '#A44133'
                      : scanNotice.level === 'critical'
                        ? '#9A4F28'
                        : scanNotice.level === 'low'
                          ? '#795B25'
                          : primary}
                  />
                  <View style={styles.scanUsageCopy}>
                    <Text style={[
                      styles.scanUsageTitle,
                      scanNotice.level === 'low' && styles.scanUsageLowText,
                      scanNotice.level === 'critical' && styles.scanUsageCriticalText,
                      scanNotice.level === 'exhausted' && styles.scanUsageExhaustedText,
                    ]}>
                      {scanNotice.title}
                    </Text>
                    <Text style={styles.scanUsageReset}>{scanNotice.reset}</Text>
                  </View>
                </View>
              )}

              <View style={styles.sourceRow}>
                <GlassPressable
                  style={styles.sourceButton}
                  onPress={() => { void pickPhotos('camera'); }}
                  disabled={isPicking || isIdentifying}
                  accessibilityLabel="Take a fridge or pantry photo"
                >
                  <Ionicons name="camera" size={21} color={primary} />
                  <Text style={styles.sourceButtonText}>Take photo</Text>
                </GlassPressable>
                <GlassPressable
                  style={styles.sourceButton}
                  onPress={() => { void pickPhotos('library'); }}
                  disabled={isPicking || isIdentifying}
                  accessibilityLabel="Choose fridge or pantry photos"
                >
                  <Ionicons name="images" size={21} color={primary} />
                  <Text style={styles.sourceButtonText}>Choose photos</Text>
                </GlassPressable>
              </View>

              {isPicking && <View style={styles.inlineLoading}>
                <ActivityIndicator size="small" color={primary} />
                <Text style={styles.loadingText}>Opening photos…</Text>
              </View>}

              {!!photos.length && (
                <View style={styles.photoSection}>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>Photos</Text>
                    <Text style={styles.count}>{photos.length} of {MAX_LEFTOVERS_PHOTOS}</Text>
                  </View>
                  {photos.map((photo, index) => (
                    <GlassSurface key={photo.id} style={styles.photoRow} intensity={55}>
                      <Image
                        source={{ uri: photo.uri }}
                        style={styles.thumbnail}
                        accessibilityLabel={`Fridge or pantry photo ${index + 1}`}
                      />
                      <View style={styles.photoMeta}>
                        <Text style={styles.photoName}>Photo {index + 1}</Text>
                        <Text style={styles.photoSize}>{(photo.byteSize / 1024 / 1024).toFixed(1)} MB compressed</Text>
                      </View>
                      <View style={styles.photoActions}>
                        <GlassPressable
                          style={styles.iconButton}
                          onPress={() => movePhoto(index, -1)}
                          disabled={index === 0 || isIdentifying || isPicking}
                          accessibilityLabel={`Move photo ${index + 1} earlier`}
                        >
                          <Ionicons name="arrow-up" size={18} color={index === 0 ? '#AAB4A8' : ink} />
                        </GlassPressable>
                        <GlassPressable
                          style={styles.iconButton}
                          onPress={() => movePhoto(index, 1)}
                          disabled={index === photos.length - 1 || isIdentifying || isPicking}
                          accessibilityLabel={`Move photo ${index + 1} later`}
                        >
                          <Ionicons name="arrow-down" size={18} color={index === photos.length - 1 ? '#AAB4A8' : ink} />
                        </GlassPressable>
                        <GlassPressable
                          style={styles.iconButton}
                          onPress={() => removePhoto(photo)}
                          disabled={isIdentifying || isPicking}
                          accessibilityLabel={`Remove photo ${index + 1}`}
                        >
                          <Ionicons name="trash-outline" size={18} color="#A44133" />
                        </GlassPressable>
                      </View>
                    </GlassSurface>
                  ))}
                </View>
              )}

              {!!notice && <Text style={styles.notice} accessibilityRole="alert">{notice}</Text>}
              {!!error && <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">{error}</Text>}

              <View style={styles.privacyCard}>
                <Ionicons name="lock-closed-outline" size={19} color={primary} />
                <View style={styles.privacyCopy}>
                  <Text style={[styles.privacyText, styles.privacyDisclosureText]}>
                    Your photos are resized and compressed, then sent to Fridgie’s external AI provider to identify ingredients. They aren’t saved to your Fridgie account, and the app deletes its temporary on-device copies when the editable list is ready or you close Leftovers Mode.
                  </Text>
                  {hasPrivacyUrl && (
                    <GlassPressable
                      style={styles.privacyLink}
                      onPress={() => { void Linking.openURL(PRO_CONFIG.privacyUrl); }}
                      accessibilityLabel="Open Fridgie privacy policy"
                    >
                      <Text style={styles.privacyLinkText}>Privacy policy</Text>
                    </GlassPressable>
                  )}
                </View>
              </View>
            </>
          ) : (
            <>
              <View style={styles.heroIcon}><Ionicons name="checkmark-circle-outline" size={34} color={primary} /></View>
              <Text style={styles.title}>Check the ingredient list</Text>
              <Text style={styles.subtitle}>
                Photo recognition can make mistakes. Fix names, remove anything that isn’t there, and add what the camera missed.
              </Text>
              {!!notice && <Text style={styles.notice} accessibilityRole="alert">{notice}</Text>}

              <View style={styles.ingredientList}>
                {ingredients.map((ingredient, index) => (
                  <View key={ingredient.id} style={styles.ingredientRow}>
                    <TextInput
                      style={styles.ingredientInput}
                      value={ingredient.name}
                      onChangeText={name => updateIngredient(ingredient.id, name)}
                      placeholder="Ingredient name"
                      placeholderTextColor={inkMuted}
                      accessibilityLabel={`Ingredient ${index + 1}`}
                      autoCapitalize="sentences"
                      maxLength={100}
                      returnKeyType="done"
                    />
                    {ingredient.confidence === 'medium' && !!ingredient.name.trim() && (
                      <View style={styles.checkBadge} accessible accessibilityLabel="Please double-check this ingredient">
                        <Text style={styles.checkBadgeText}>CHECK</Text>
                      </View>
                    )}
                    <GlassPressable
                      style={styles.removeIngredient}
                      onPress={() => removeIngredient(ingredient.id)}
                      accessibilityLabel={`Remove ${ingredient.name || `ingredient ${index + 1}`}`}
                    >
                      <Ionicons name="close-circle" size={22} color={inkMuted} />
                    </GlassPressable>
                  </View>
                ))}
                <GlassPressable
                  style={styles.addIngredient}
                  onPress={addIngredient}
                  disabled={ingredients.length >= MAX_LEFTOVERS_INGREDIENTS}
                  accessibilityLabel="Add an ingredient"
                >
                  <Ionicons name="add" size={18} color={primary} />
                  <Text style={styles.addIngredientText}>Add ingredient</Text>
                </GlassPressable>
              </View>

              <View style={styles.safetyCard}>
                <Ionicons name="shield-checkmark-outline" size={19} color={primary} />
                <Text style={styles.privacyText}>
                  Fridgie will still apply the dietary needs and dislikes selected in Suggest Meals. A photo can’t confirm that an allergen is absent or that food is safe to eat.
                </Text>
              </View>
            </>
          )}
        </ScrollView>

        <View style={styles.footer}>
          {stage === 'photos' ? (
            <GlassPressable
              style={[styles.primaryButton, (!photos.length || isIdentifying || isPicking) && styles.primaryButtonDisabled]}
              onPress={() => { void identify(); }}
              disabled={!photos.length || isIdentifying || isPicking}
              accessibilityLabel={isIdentifying
                ? 'Identifying visible ingredients'
                : knownScanExhausted
                  ? 'Check whether Leftovers Mode scans are available again'
                  : 'Identify visible ingredients'}
            >
              {isIdentifying ? <ActivityIndicator size="small" color="#FFF" /> : <Ionicons name={knownScanExhausted ? 'refresh' : 'sparkles'} size={19} color="#FFF" />}
              <Text style={styles.primaryButtonText}>
                {isIdentifying ? 'Checking photos…' : knownScanExhausted ? 'Check scan availability' : 'Find ingredients'}
              </Text>
            </GlassPressable>
          ) : (
            <GlassPressable
              style={[styles.primaryButton, (!usableIngredients.length || isIdentifying) && styles.primaryButtonDisabled]}
              onPress={() => { void confirm(); }}
              disabled={!usableIngredients.length || isIdentifying}
              accessibilityLabel="Use confirmed ingredients for meal suggestions"
            >
              {isIdentifying ? <ActivityIndicator size="small" color="#FFF" /> : <Ionicons name="restaurant-outline" size={19} color="#FFF" />}
              <Text style={styles.primaryButtonText}>Suggest meals from these</Text>
            </GlassPressable>
          )}
        </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // The parent already owns a native full-screen Modal. Rendering this as an
  // in-modal layer avoids unreliable stacked Modal presentation on iOS.
  screen: { ...StyleSheet.absoluteFillObject, zIndex: 20, backgroundColor: '#F5F5EF' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 0, borderWidth: 0 },
  headerButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E5EDE3' },
  headerCopy: { flex: 1, alignItems: 'center' },
  eyebrow: { color: primary, fontSize: 9, fontWeight: '800', letterSpacing: 1.4 },
  headerTitle: { color: ink, fontSize: 18, fontWeight: '700', letterSpacing: -0.4, marginTop: 1 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 22, paddingTop: 26, paddingBottom: 24 },
  heroIcon: { width: 66, height: 66, borderRadius: 24, backgroundColor: '#DCEDE2', alignSelf: 'center', alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontSize: 27, lineHeight: 32, fontWeight: '700', letterSpacing: -0.9, color: ink, textAlign: 'center' },
  subtitle: { fontSize: 14, lineHeight: 22, color: inkMuted, textAlign: 'center', marginTop: 9, marginHorizontal: 10 },
  scanUsageCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: '#E8EEE3', borderRadius: 18, padding: 13, marginTop: 18, borderWidth: 1, borderColor: '#D6E2D2' },
  scanUsageLow: { backgroundColor: '#F6ECD4', borderColor: '#E9D5A6' },
  scanUsageCritical: { backgroundColor: '#F8E4CF', borderColor: '#ECC49D' },
  scanUsageExhausted: { backgroundColor: '#F9E6E1', borderColor: '#EDC4BA' },
  scanUsageCopy: { flex: 1 },
  scanUsageTitle: { color: primary, fontSize: 13, lineHeight: 18, fontWeight: '700' },
  scanUsageLowText: { color: '#795B25' },
  scanUsageCriticalText: { color: '#9A4F28' },
  scanUsageExhaustedText: { color: '#A44133' },
  scanUsageReset: { color: inkMuted, fontSize: 11, lineHeight: 16, marginTop: 2 },
  sourceRow: { flexDirection: 'row', gap: 10, marginTop: 24 },
  sourceButton: { flex: 1, minHeight: 58, borderRadius: 21, backgroundColor: '#FFFFFF', flexDirection: 'row', gap: 9, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#E1E7DE' },
  sourceButtonText: { fontSize: 14, color: ink, fontWeight: '600' },
  inlineLoading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16 },
  loadingText: { color: inkMuted, fontSize: 13 },
  photoSection: { marginTop: 25 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 9 },
  sectionTitle: { fontSize: 15, color: ink, fontWeight: '700' },
  count: { fontSize: 12, color: inkMuted },
  photoRow: { minHeight: 78, borderRadius: 21, padding: 9, marginBottom: 9, flexDirection: 'row', alignItems: 'center' },
  thumbnail: { width: 58, height: 58, borderRadius: 15, backgroundColor: '#DCE3D8' },
  photoMeta: { flex: 1, marginLeft: 12 },
  photoName: { color: ink, fontSize: 14, fontWeight: '600' },
  photoSize: { color: inkMuted, fontSize: 11, marginTop: 3 },
  photoActions: { flexDirection: 'row', gap: 2 },
  iconButton: { width: 34, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 16 },
  notice: { color: '#795B25', backgroundColor: '#F6ECD4', borderRadius: 16, padding: 12, fontSize: 12, lineHeight: 18, marginTop: 14 },
  error: { color: '#A44133', backgroundColor: '#F9E6E1', borderRadius: 16, padding: 12, fontSize: 13, lineHeight: 19, marginTop: 14 },
  privacyCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: '#E8EEE3', padding: 15, borderRadius: 19, marginTop: 22 },
  safetyCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: '#E8EEE3', padding: 15, borderRadius: 19, marginTop: 20 },
  privacyText: { flex: 1, color: inkMuted, fontSize: 12, lineHeight: 19 },
  privacyDisclosureText: { flex: 0 },
  privacyCopy: { flex: 1, alignItems: 'flex-start' },
  privacyLink: { marginTop: 7, paddingVertical: 5, paddingHorizontal: 8, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.55)' },
  privacyLinkText: { color: primary, fontSize: 12, fontWeight: '700' },
  ingredientList: { marginTop: 23, gap: 9 },
  ingredientRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E1E7DE', borderRadius: 19, paddingLeft: 15, paddingRight: 8 },
  ingredientInput: { flex: 1, minHeight: 52, color: ink, fontSize: 15, paddingVertical: 10 },
  checkBadge: { backgroundColor: '#F6ECD4', borderRadius: 9, paddingHorizontal: 7, paddingVertical: 4, marginLeft: 6 },
  checkBadgeText: { color: '#795B25', fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  removeIngredient: { width: 38, height: 42, alignItems: 'center', justifyContent: 'center' },
  addIngredient: { flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'flex-start', paddingVertical: 11, paddingHorizontal: 13, borderRadius: 18, backgroundColor: '#E6EDE1' },
  addIngredientText: { color: primary, fontSize: 13, fontWeight: '600' },
  footer: { paddingHorizontal: 20, paddingTop: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DCE3D8', backgroundColor: '#F5F5EF' },
  primaryButton: { minHeight: 54, borderRadius: 23, backgroundColor: primary, flexDirection: 'row', gap: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  primaryButtonDisabled: { backgroundColor: '#ADBEAE' },
  primaryButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
});
