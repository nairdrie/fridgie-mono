import { useKeyboardAwareScroll } from '@/hooks/useKeyboardAwareScroll';
import { Ingredient, Item, Meal, Recipe } from '@/types/types';
import { accentSoft, hairline, ink, inkFaint, inkMuted, primary } from '@/utils/styles';
import { GlassPressable, GlassSurface, useGlassPreferences } from '@/components/ui/Glass';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Image, Keyboard, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import uuid from 'react-native-uuid';
import { generateRecipeFromTitle, getRecipe, importRecipeFromPhoto, importRecipeFromUrl, saveRecipe, uploadRecipePhoto } from '../utils/api';
import { useAuth } from '@/context/AuthContext';
import { parseServings, scaleIngredients, servingsScale } from '@/utils/servings';
import { createRecipeImportGuard, parseRecipeImportInput, recipeImportProblem, recipeSourceLabel, type RecipeImportProblem } from '@/utils/recipeImport';

/** Long enough for the sheet's slide-out to finish, short enough not to read as a stall. */
const SHEET_DISMISS_MS = 260;

/**
 * How long a launch gets to bring something to the front before it is treated
 * as never coming. Only counted while the app stays in the foreground, so a
 * slow camera app costs nothing.
 */
const LAUNCH_STALLED_AFTER_MS = 6000;

interface AddEditRecipeModalProps {
  isVisible: boolean;
  onClose: () => void;
  onDismiss?: () => void;
  /**
   * The meal this recipe is being written for, when there is one. Null for a
   * recipe going straight to the cookbook: nothing is planned for a day and
   * nothing lands on a shopping list, so there is no meal to speak of.
   */
  mealForRecipe: Meal | null;
  /**
   * A recipe to open straight into the editor. The cookbook already holds the
   * whole recipe by the time Edit is tapped, so it hands it over rather than
   * sending the form back to fetch what it already has.
   */
  recipeToEdit?: Recipe | null;
  /**
   * `updatedMeal` and `newItems` are null and empty for a cookbook recipe —
   * there is no meal to point at the recipe and no ingredients to shop for.
   * `savedRecipe` is what the server stored, and its id is NOT necessarily the
   * one that went in: saving someone else's recipe forks it.
   */
  onRecipeSave: (updatedMeal: Meal | null, newItems: Item[], savedRecipe: Recipe) => void | Promise<void>;
  /** Raw link/share text. A stable ID identifies one OS share across auth/renders. */
  initialImportUrl?: string;
  initialImportRequestId?: string;
}

export default function AddEditRecipeModal({ isVisible, onClose, onDismiss, mealForRecipe, recipeToEdit = null, onRecipeSave, initialImportUrl, initialImportRequestId }: AddEditRecipeModalProps) {
  const contextKey = recipeToEdit ? `recipe:${recipeToEdit.id}` : mealForRecipe ? `meal:${mealForRecipe.id}:${mealForRecipe.recipeId ?? ''}` : 'cookbook';
  const renderedContext = useRef(contextKey);
  renderedContext.current = contextKey;
  const { selectedGroup } = useAuth();
  // Every field on this form is inside the scroller below, and focus bubbles,
  // so the scroller hears all of them — including the ingredient and step rows,
  // which come and go as the recipe is written.
  const keyboard = useKeyboardAwareScroll({ enabled: isVisible });
  const { reduceMotion } = useGlassPreferences();
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);
  const [importUrl, setImportUrl] = useState('');
  // Seeded from the meal's own title: someone who typed "Chicken Katsu" into
  // their plan has already said what they want, so the field arrives filled in
  // and the whole flow is two taps. It stays editable because the title is
  // also the place to add "for two" or "make it spicy".
  const [generateTitle, setGenerateTitle] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  // True from the tap until the camera or the photo library is done with us.
  const [isPickerBusy, setIsPickerBusy] = useState(false);
  const [importSource, setImportSource] = useState<'link' | 'photo' | 'generate'>('link');
  const [isLoading, setIsLoading] = useState(false);
  const [creationMode, setCreationMode] = useState<'initial' | 'link' | 'photo' | 'generate' | 'manual'>('initial');
  const [isSaving, setIsSaving] = useState(false);
  const [importProblem, setImportProblem] = useState<RecipeImportProblem | null>(null);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [isReviewingImport, setIsReviewingImport] = useState(false);
  const [pendingShare, setPendingShare] = useState<{ id: string; text: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; label: string; confirm: () => void } | null>(null);
  const guard = useRef(createRecipeImportGuard());
  const operation = useRef<'load' | 'import' | 'picker' | 'save' | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const initializedSession = useRef<string | null>(null);
  const visible = useRef(isVisible);
  visible.current = isVisible;
  const draft = useRef<Recipe | null>(editingRecipe);
  draft.current = editingRecipe;
  const dirty = useRef(false);
  const hasWork = useRef(false);
  const savedDraft = useRef<{ draft: Recipe; saved: Recipe } | null>(null);
  const callbacks = useRef({ onClose, onRecipeSave });
  callbacks.current = { onClose, onRecipeSave };
  const isCurrent = useCallback((request: number) => mounted.current && visible.current
    && initializedSession.current === `open:${renderedContext.current}` && guard.current.isCurrent(request), []);
  const isSaveDisabled = creationMode !== 'manual' || !editingRecipe?.name?.trim() || isSaving || isLoading || isImporting || isPickerBusy;
  const parsedImport = useMemo(() => parseRecipeImportInput(importUrl), [importUrl]);
  const isSocialImport = 'platform' in parsedImport && parsedImport.platform !== 'web';

  // ✅ 1. State for the animated loading message
  const [importingMessage, setImportingMessage] = useState('Fetching your recipe...');

  // Opened on a recipe that already exists, rather than at the four ways of
  // starting one — so there is no earlier step to go back to.
  const isEditingExisting = !!(recipeToEdit || mealForRecipe?.recipeId);

  /**
   * A recipe written by hand is written for whoever is writing it, so the
   * Serves box opens on the household's usual count rather than empty. It stays
   * editable — this is a claim about the amounts the author is about to type,
   * and they are free to type amounts for a crowd.
   */
  const createBlankRecipe = (): Recipe => ({
    id: uuid.v4() as string,
    name: mealForRecipe?.name || '',
    description: '',
    ingredients: [{ name: '', quantity: '' }],
    instructions: [''],
    ...(selectedGroup?.householdSize ? { servings: selectedGroup.householdSize } : {}),
  });
  
  const inputs = useRef({ mealForRecipe, recipeToEdit, createBlankRecipe });
  inputs.current = { mealForRecipe, recipeToEdit, createBlankRecipe };

  // ✅ 2. useEffect to cycle through loading messages
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined = undefined;

    if (isImporting) {
        const messages = importSource === 'photo'
          ? [
              'Reading the page...',
              'Making out the ingredients...',
              'Working through the steps...',
              'Almost there...'
            ]
          : importSource === 'generate'
          ? [
              'Thinking about the dish...',
              'Choosing the ingredients...',
              'Working out the quantities...',
              'Writing the method...',
              'Almost there...'
            ]
          : isSocialImport
          ? [
              'Reading this video...',
              'Still working on this video...'
            ]
          : [
              'Fetching your recipe...',
              'Analyzing ingredients...',
              'Extracting steps...',
              'Just a moment longer...'
            ];
        let messageIndex = 0;
        setImportingMessage(messages[messageIndex]); // Set initial message
        
        interval = setInterval(() => {
            messageIndex = messageIndex + 1;
            if(messageIndex >= messages.length) {
              messageIndex = messages.length - 1;
            }
            setImportingMessage(messages[messageIndex]);
        }, importSource === 'link' && isSocialImport ? 20_000 : 3000);
    }

    // Cleanup function to clear the interval
    return () => {
        if (interval) {
            clearInterval(interval);
        }
    };
  }, [isImporting, importSource, isSocialImport]);

  useEffect(() => {
    const session = `${isVisible ? 'open' : 'closed'}:${contextKey}`;
    if (initializedSession.current === session) return;
    initializedSession.current = session;
    const request = guard.current.begin();
    operation.current = null;
    dirty.current = false;
    hasWork.current = false;
    savedDraft.current = null;
    setIsImporting(false);
    setIsPickerBusy(false);
    setIsSaving(false);
    setImportProblem(null);
    setSaveProblem(null);
    setIsReviewingImport(false);
    setPendingShare(null);
    setConfirmation(null);
    if (!isVisible) {
      draft.current = null;
      setEditingRecipe(null);
      return;
    }
    const { mealForRecipe: meal, recipeToEdit: recipe, createBlankRecipe: blank } = inputs.current;
    setImportUrl('');
    setGenerateTitle(meal?.name || '');
    if (recipe) {
      hasWork.current = true;
      draft.current = recipe;
      setEditingRecipe(recipe);
      setCreationMode('manual');
      setIsLoading(false);
    } else if (meal?.recipeId) {
      operation.current = 'load';
      hasWork.current = true;
      setIsLoading(true);
      setCreationMode('manual');
      void getRecipe(meal.recipeId).then(existing => {
        if (!isCurrent(request)) return;
        draft.current = existing;
        setEditingRecipe(existing);
      }).catch(error => {
        if (!isCurrent(request)) return;
        console.error('Failed to fetch recipe for editing', error);
        Alert.alert('Error', 'Could not load the recipe to edit.');
        callbacks.current.onClose();
      }).finally(() => {
        if (isCurrent(request)) { operation.current = null; setIsLoading(false); }
      });
    } else {
      const fresh = blank();
      draft.current = fresh;
      setEditingRecipe(fresh);
      setCreationMode('initial');
      setIsLoading(false);
    }
    // Recipe identity, rather than incoming object identity, preserves typed edits.
  }, [isVisible, contextKey, isCurrent]);

  const startLinkImport = useCallback(async (text: string) => {
    if (operation.current || !visible.current) return;
    const input = parseRecipeImportInput(text);
    setImportProblem(null);
    if ('error' in input) {
      setImportProblem({ title: 'Check this link', message: input.error, retryable: false });
      return;
    }
    Keyboard.dismiss();
    const request = guard.current.begin();
    const draftId = draft.current?.id ?? inputs.current.createBlankRecipe().id;
    operation.current = 'import';
    hasWork.current = true;
    setImportUrl(input.url);
    setCreationMode('link');
    setImportSource('link');
    setIsImporting(true);
    try {
      const imported = await importRecipeFromUrl(input.url);
      if (!isCurrent(request)) return;
      const next = { ...imported, id: draftId, sourceUrl: imported.sourceUrl || input.url };
      draft.current = next;
      dirty.current = true;
      savedDraft.current = null;
      setEditingRecipe(next);
      setIsReviewingImport(true);
      setCreationMode('manual');
      keyboard.scrollRef.current?.scrollTo?.({ y: 0, animated: false });
    } catch (error) {
      if (!isCurrent(request)) return;
      console.error('Failed to import recipe', error);
      setImportProblem(recipeImportProblem(error));
    } finally {
      if (isCurrent(request)) { operation.current = null; setIsImporting(false); }
    }
  }, [isCurrent, keyboard.scrollRef]);

  const beginSharedImport = useCallback((share: { id: string; text: string }) => {
    guard.current.invalidate();
    operation.current = null;
    const fresh = inputs.current.createBlankRecipe();
    draft.current = fresh;
    dirty.current = false;
    hasWork.current = false;
    savedDraft.current = null;
    setEditingRecipe(fresh);
    setPendingShare(null);
    setSaveProblem(null);
    setIsReviewingImport(false);
    setIsLoading(false);
    setIsPickerBusy(false);
    setIsImporting(false);
    setImportUrl(share.text);
    setCreationMode('link');
    void startLinkImport(share.text);
  }, [startLinkImport]);

  useEffect(() => {
    if (!isVisible || !initialImportUrl) return;
    const share = { id: initialImportRequestId || `url:${initialImportUrl}`, text: initialImportUrl };
    if (!guard.current.consumeShare(share.id)) {
      // A login interruption or a parent reopening the same request keeps the
      // link available without automatically extracting that request twice.
      if (!hasWork.current && !dirty.current && !operation.current) {
        setImportUrl(share.text);
        setCreationMode('link');
      }
      return;
    }
    if (hasWork.current || dirty.current || operation.current) setPendingShare(share);
    else beginSharedImport(share);
  }, [isVisible, initialImportUrl, initialImportRequestId, beginSharedImport]);

  const handleImportRecipe = () => { void startLinkImport(importUrl); };

  const stopImport = () => {
    guard.current.invalidate();
    operation.current = null;
    setIsImporting(false);
    setIsPickerBusy(false);
  };

  const closeNow = () => {
    guard.current.invalidate();
    operation.current = null;
    dirty.current = false;
    setIsSaving(false);
    setIsImporting(false);
    setIsPickerBusy(false);
    setConfirmation(null);
    callbacks.current.onClose();
  };

  const requestClose = () => {
    if (operation.current === 'save') return;
    if (!dirty.current) { closeNow(); return; }
    Keyboard.dismiss();
    setConfirmation({ title: 'Leave this draft?', message: 'Your unsaved changes will be discarded.', label: 'Discard draft', confirm: closeNow });
  };

  const reviewPendingShare = () => {
    if (!pendingShare || operation.current === 'save') return;
    const share = pendingShare;
    Keyboard.dismiss();
    setConfirmation({ title: 'Start the shared recipe?', message: 'This will replace the draft you have open.', label: 'Use shared link', confirm: () => beginSharedImport(share) });
  };

  /**
   * Runs a picker launch that is allowed to take as long as the user does, but
   * not allowed to never come back at all.
   *
   * A timeout on the promise itself would be wrong — it settles when the photo
   * is taken, so someone lining up a shot would trip it. What separates the two
   * cases is the app: a camera or a picker that really opened puts the app in
   * the background, and one that never opened leaves it in the foreground. So
   * watch that instead. Still in the foreground seconds later means nothing
   * opened, and the launch is not coming back.
   *
   * A launch given up on is left running rather than cancelled — there is no
   * cancelling it — but its result is dropped, so a camera that surfaces later
   * can be backed out of without a photo arriving from nowhere.
   */
  const launchWatched = (
    launch: () => Promise<ImagePicker.ImagePickerResult>
  ): Promise<{ ok: ImagePicker.ImagePickerResult } | { stalled: true } | { failed: any }> =>
    new Promise(resolve => {
      let settled = false;
      let leftForeground = false;
      const finish = (value: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        subscription.remove();
        resolve(value);
      };
      const subscription = AppState.addEventListener('change', state => {
        if (state !== 'active') leftForeground = true;
      });
      const timer = setTimeout(() => {
        if (!leftForeground) finish({ stalled: true });
      }, LAUNCH_STALLED_AFTER_MS);
      launch().then(result => finish({ ok: result }), error => finish({ failed: error }));
    });

  /**
   * Tells the user the camera is off limits, and offers the only thing that
   * can change that once the OS has stopped asking: Settings.
   */
  const cameraDenied = (canAskAgain: boolean) => Alert.alert(
    'Camera access needed',
    canAskAgain
      ? 'Fridgie needs camera access to photograph a recipe.'
      : 'Fridgie needs camera access to photograph a recipe. You can turn it on in Settings.',
    canAskAgain
      ? [{ text: 'OK' }]
      : [{ text: 'Not now', style: 'cancel' }, { text: 'Open Settings', onPress: () => Linking.openSettings() }]
  );

  /**
   * Puts the camera or the photo library in front of the user and hands back
   * what they picked, or null once they have been told why they can't be.
   *
   * The permission is handled the way Expo documents it and the way the OS
   * guidelines ask for: read the current state first, ask only if the OS is
   * still willing to ask, and once it isn't, stop asking and offer Settings —
   * all of it at the point of use, when the user has just said they want a
   * photo, rather than up front.
   *
   * Exactly ONE request is made per tap, which matters more here than it looks.
   * `launchCameraAsync` asks for the camera permission itself on Android — it
   * calls `askForPermissions` with no check first (expo-image-picker's
   * `ensureCameraPermissionsAreGranted`, unchanged as of 57.x) — so asking here
   * as well puts two `Activity.requestPermissions` calls back to back. React
   * Native parks a permission result and only delivers it from the activity's
   * next `onResume`, and overlapping requests strand one of them; that is a tap
   * that does nothing, and a camera that opens out of nowhere much later when
   * something else finally resumes the activity. So on Android the read is only
   * used to decide what to say, and the asking is left to the launcher. On iOS
   * the launcher only *checks* and refuses outright without it, so there the
   * asking has to happen here.
   *
   * The photo library needs no permission on either platform — the system
   * picker runs out of process and hands back only what was chosen — which is
   * why "Choose an Image" always worked while this didn't.
   */
  const openRecipePhotoPicker = async (
    source: 'camera' | 'library',
    request: number
  ): Promise<ImagePicker.ImagePickerResult | null> => {
    if (source === 'camera') {
      // A plain read. It never reaches Activity.requestPermissions, so unlike a
      // request it cannot be the thing that gets stuck.
      let permission = await ImagePicker.getCameraPermissionsAsync();
      if (!isCurrent(request)) return null;

      // Who does the asking is the whole point: iOS won't open the camera
      // without the permission already in hand, so it is asked for here.
      // Android's launcher asks for itself, and asking on top of that is what
      // strands the request — so there, don't.
      if (!permission.granted && permission.canAskAgain && Platform.OS !== 'android') {
        permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!isCurrent(request)) return null;
      }

      // Turned down for good. The OS has stopped offering to ask, so launching
      // would only bounce off the same wall — Settings is the only way back.
      if (!permission.granted && !permission.canAskAgain) {
        cameraDenied(false);
        return null;
      }

      // Declined this time round, on the platform that won't try without it.
      if (!permission.granted && Platform.OS !== 'android') {
        cameraDenied(true);
        return null;
      }
    }

    const options: ImagePicker.ImagePickerOptions = {
      // `MediaTypeOptions.Images` is deprecated in expo-image-picker 16 and gone
      // in 17; the array form is the supported spelling.
      mediaTypes: ['images'],
      // Deliberately NOT allowsEditing. On iOS the crop box is always a square,
      // so a portrait cookbook page came back with its top and bottom cut off —
      // half the ingredients gone before the reader ever saw them. It also puts
      // a second activity, the cropper, between the camera and the answer on
      // Android. The whole photo is what the reader wants.
      allowsEditing: false,
      // Text needs detail, but this travels as base64 — quality is a balance.
      quality: 0.6,
      base64: true,
    };

    // Launching can throw outright — no camera on the device, a permission
    // refused inside the launcher, an OS that won't present it. Uncaught, that
    // surfaced as the whole screen dying rather than as a message. And it can
    // fail to come back at all, which is what `launchWatched` is for.
    const outcome = await launchWatched(() => (source === 'camera'
      ? ImagePicker.launchCameraAsync(options)
      : ImagePicker.launchImageLibraryAsync(options)));

    if (!isCurrent(request)) return null;
    if ('ok' in outcome) return outcome.ok;

    if ('stalled' in outcome) {
      console.warn(`The ${source} never opened — see openRecipePhotoPicker.`);
      Alert.alert(
        source === 'camera' ? "The camera didn't open" : "Your photos didn't open",
        source === 'camera'
          ? "Android didn't hand the camera over. Choosing a photo you've already taken works — or take one with your camera app and pick it here."
          : 'Please try again, or enter the recipe manually.',
        source === 'camera'
          ? [{ text: 'Not now', style: 'cancel' }, { text: 'Choose an Image', onPress: () => handleImportFromPhoto('library') }]
          : [{ text: 'OK' }]
      );
      return null;
    }

    const error: any = outcome.failed;
    console.error('Failed to open the image picker', error);
    const failure = `${error?.code ?? ''} ${error?.message ?? ''}`;

    // Android leaves its own camera prompt to the launcher, so a refusal
    // arrives here rather than as a status we could have read beforehand.
    // Reading it afterwards is not requesting it, so it is safe, and it is the
    // difference between "allow it next time" and "go to Settings".
    if (failure.includes('USER_REJECTED_PERMISSIONS')) {
      const permission = await ImagePicker.getCameraPermissionsAsync().catch(() => null);
      if (isCurrent(request)) cameraDenied(permission?.canAskAgain ?? false);
      return null;
    }

    // No camera app installed, or none the OS will let us see. Nothing to
    // retry, so send them the way that does work.
    if (failure.includes('MISSING_ACTIVITY_TO_HANDLE_INTENT') || failure.includes('CAMERA_UNAVAILABLE')) {
      Alert.alert(
        'No camera available',
        "This device doesn't have a camera app we can open. You can still pick a photo you've already taken.",
        [{ text: 'Not now', style: 'cancel' }, { text: 'Choose an Image', onPress: () => handleImportFromPhoto('library') }]
      );
      return null;
    }

    Alert.alert(
      source === 'camera' ? "Couldn't open the camera" : "Couldn't open your photos",
      'Please try again, or enter the recipe manually.'
    );
    return null;
  };

  /**
   * Reads a recipe out of a photo of a page. Lands in the same manual editor as
   * a link import, so the user reviews and corrects before saving — reading
   * handwriting produces a first draft, not an answer.
   */
  const handleImportFromPhoto = async (source: 'camera' | 'library') => {
    if (operation.current || !visible.current) return;
    const request = guard.current.begin();
    const draftId = draft.current?.id ?? createBlankRecipe().id;
    operation.current = 'picker';
    hasWork.current = true;
    setIsPickerBusy(true);
    try {
      if (Platform.OS === 'android') await new Promise(resolve => setTimeout(resolve, SHEET_DISMISS_MS));
      if (!isCurrent(request)) return;
      const result = await openRecipePhotoPicker(source, request);
      if (!isCurrent(request) || !result || result.canceled) return;
      setIsPickerBusy(false);
      const asset = result.assets?.[0];
      if (!asset?.base64) {
        Alert.alert('Error', "Couldn't read that image. Please try again.");
        return;
      }
      operation.current = 'import';
      setImportSource('photo');
      setIsImporting(true);
      const mime = asset.mimeType?.startsWith('image/') ? asset.mimeType : 'image/jpeg';
      const imported = await importRecipeFromPhoto(`data:${mime};base64,${asset.base64}`);
      if (!isCurrent(request)) return;
      const next = { ...imported, id: draftId };
      draft.current = next;
      dirty.current = true;
      savedDraft.current = null;
      setEditingRecipe(next);
      setIsReviewingImport(true);
      setCreationMode('manual');
    } catch (error: any) {
      if (!isCurrent(request)) return;
      console.error('Failed to import recipe from photo', error);
      const notARecipe = typeof error?.message === 'string' && error.message.includes('RECIPE_NOT_FOUND');
      Alert.alert(notARecipe ? 'No recipe found' : 'Import failed', notARecipe
        ? "That photo doesn't look like a recipe. Try a clearer shot of the page."
        : "Couldn't read that image. Try again with more light, or enter it manually.");
    } finally {
      if (isCurrent(request)) {
        operation.current = null;
        setIsPickerBusy(false);
        setIsImporting(false);
      }
    }
  };

  /**
   * Writes a recipe from the dish name alone. Lands in the same manual editor
   * as the two importers, deliberately: what comes back is a plausible first
   * draft, and the user should see the quantities before they become a
   * shopping list.
   */
  const handleGenerateRecipe = async () => {
    const title = generateTitle.trim();
    if (!title || operation.current || !visible.current) return;
    Keyboard.dismiss();
    const request = guard.current.begin();
    const draftId = draft.current?.id ?? createBlankRecipe().id;
    operation.current = 'import';
    hasWork.current = true;
    setImportSource('generate');
    setIsImporting(true);
    try {
      const generated = await generateRecipeFromTitle(title, selectedGroup?.householdSize);
      if (!isCurrent(request)) return;
      const next = { ...generated, id: draftId };
      draft.current = next;
      dirty.current = true;
      savedDraft.current = null;
      setEditingRecipe(next);
      setIsReviewingImport(true);
      setCreationMode('manual');
    } catch (error: any) {
      if (!isCurrent(request)) return;
      console.error('Failed to generate recipe', error);
      const notFood = typeof error?.message === 'string' && error.message.includes('RECIPE_NOT_FOUND');
      Alert.alert(notFood ? "That doesn't sound like a dish" : 'Could not write that recipe', notFood
        ? 'Try naming a dish, like “chicken katsu curry”.'
        : 'Something went wrong writing that recipe. Please try again.');
    } finally {
      if (isCurrent(request)) { operation.current = null; setIsImporting(false); }
    }
  };

  const resetToOptions = () => {
    stopImport();
    const fresh = createBlankRecipe();
    draft.current = fresh;
    dirty.current = false;
    hasWork.current = false;
    savedDraft.current = null;
    setCreationMode('initial');
    setEditingRecipe(fresh);
    setIsReviewingImport(false);
    setSaveProblem(null);
    setImportProblem(null);
    setImportUrl('');
    setGenerateTitle(mealForRecipe?.name || '');
  };

  const handleBackPress = () => {
    if (operation.current === 'save') return;
    if (!dirty.current) { resetToOptions(); return; }
    Keyboard.dismiss();
    setConfirmation({ title: 'Start another way?', message: 'Your current draft will be discarded.', label: 'Discard draft', confirm: resetToOptions });
  };

  const handleSaveRecipe = async () => {
    const recipeDraft = draft.current;
    if (!recipeDraft?.name?.trim() || operation.current) return;
    const request = guard.current.begin();
    operation.current = 'save';
    setIsSaving(true);
    setSaveProblem(null);
    let recipeWasSaved = false;
    try {
      let savedRecipe: Recipe;
      if (savedDraft.current?.draft === recipeDraft) {
        savedRecipe = savedDraft.current.saved;
      } else {
        let photoURL = recipeDraft.photoURL;
        if (photoURL && !photoURL.startsWith('http')) photoURL = await uploadRecipePhoto(photoURL, recipeDraft.id);
        if (!isCurrent(request)) return;
        const recipeToSave = {
          ...recipeDraft,
          ...(photoURL ? { photoURL } : {}),
          ingredients: (recipeDraft.ingredients || []).filter(i => (i.name ?? '').trim() !== ''),
          instructions: (recipeDraft.instructions || []).filter(i => (i ?? '').trim() !== ''),
        };
        savedRecipe = await saveRecipe(recipeToSave);
      }
      recipeWasSaved = true;
      if (!isCurrent(request)) return;
      // Retain the server ID (including forks), so retrying a failed cookbook
      // filing does not create another recipe or discard the user's review.
      draft.current = savedRecipe;
      setEditingRecipe(savedRecipe);
      savedDraft.current = { draft: savedRecipe, saved: savedRecipe };
      const updatedMeal = mealForRecipe ? { ...mealForRecipe, recipeId: savedRecipe.id, name: savedRecipe.name } : null;
      const scale = servingsScale(savedRecipe.servings, selectedGroup?.householdSize);
      const newItemsForRecipe = mealForRecipe
        ? scaleIngredients(savedRecipe.ingredients, scale).map(ing => ({ id: uuid.v4() as string, text: ing.name.trim(), quantity: (ing.quantity ?? '').trim(), checked: false, listOrder: 'NEEDS-RANK', isSection: false, mealId: mealForRecipe.id }))
        : [];
      if (updatedMeal && scale !== 1) updatedMeal.scale = scale;
      await callbacks.current.onRecipeSave(updatedMeal, newItemsForRecipe, savedRecipe);
      if (!isCurrent(request)) return;
      dirty.current = false;
      closeNow();
    } catch (error) {
      if (!isCurrent(request)) return;
      console.error('Failed to save recipe', error);
      setSaveProblem(recipeWasSaved
        ? 'Your recipe is saved, but we couldn’t finish adding it. Try saving again; your reviewed recipe is still here.'
        : 'We couldn’t save this recipe. Check your connection and try again. Your draft is still here.');
    } finally {
      if (isCurrent(request)) { operation.current = null; setIsSaving(false); }
    }
  };

  const handlePickImage = async () => {
    if (operation.current) return;
    const request = guard.current.begin();
    operation.current = 'picker';
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [16, 9], quality: 0.7 });
      if (isCurrent(request) && !result.canceled && result.assets[0]?.uri) handleRecipeFieldChange('photoURL', result.assets[0].uri);
    } catch (error) {
      if (!isCurrent(request)) return;
      console.error('Failed to open the image picker', error);
      Alert.alert("Couldn't open your photos", 'Please try again.');
    } finally {
      if (isCurrent(request)) operation.current = null;
    }
  };

  const updateDraft = (change: (previous: Recipe) => Recipe) => {
    dirty.current = true;
    hasWork.current = true;
    savedDraft.current = null;
    setSaveProblem(null);
    setEditingRecipe(previous => {
      if (!previous) return null;
      const next = change(previous);
      draft.current = next;
      return next;
    });
  };

  const handleRecipeFieldChange = (field: keyof Recipe, value: string) => updateDraft(previous => ({ ...previous, [field]: value }));
  const handleServingsChange = (value: string) => updateDraft(previous => {
    const next = { ...previous };
    const parsed = parseServings(value);
    if (parsed) next.servings = parsed;
    else delete next.servings;
    return next;
  });
  const handleIngredientChange = (index: number, field: keyof Ingredient, value: string) => updateDraft(previous => ({ ...previous, ingredients: previous.ingredients.map((ingredient, row) => row === index ? { ...ingredient, [field]: value } : ingredient) }));
  const addIngredientField = () => updateDraft(previous => ({ ...previous, ingredients: [...previous.ingredients, { name: '', quantity: '' }] }));
  const removeIngredientField = (index: number) => updateDraft(previous => ({ ...previous, ingredients: previous.ingredients.filter((_, row) => row !== index) }));
  const handleInstructionChange = (index: number, value: string) => updateDraft(previous => ({ ...previous, instructions: previous.instructions.map((instruction, row) => row === index ? value : instruction) }));
  const addInstructionField = () => updateDraft(previous => ({ ...previous, instructions: [...previous.instructions, ''] }));
  const removeInstructionField = (index: number) => updateDraft(previous => ({ ...previous, instructions: previous.instructions.filter((_, row) => row !== index) }));

  const renderContent = () => {
    if (isLoading) return <ActivityIndicator style={{ marginTop: 40 }} size="large" />;
    
    if (creationMode === 'initial') {
      const options = [
        { mode: 'generate', icon: 'sparkles-outline', title: 'Write me a recipe', description: mealForRecipe?.name?.trim() ? `A fresh recipe for ${mealForRecipe.name.trim()}, written for you.` : 'Name a dish. We’ll write the ingredients and steps.' },
        { mode: 'link', icon: 'link-outline', title: 'Save from a link', description: 'A recipe page, a TikTok, an Instagram favourite.' },
        { mode: 'photo', icon: 'camera-outline', title: 'Scan a recipe', description: 'A cookbook page, a screenshot, a family favourite.' },
        { mode: 'manual', icon: 'create-outline', title: 'Make it your own', description: 'Write your recipe, one delicious detail at a time.' },
      ] as const;
      return (
        <View>
          <View style={styles.creationIntro}>
            <Text style={styles.creationEyebrow}>GOOD FOOD STARTS HERE</Text>
            <Text style={styles.creationTitle}>A recipe worth keeping.</Text>
            <Text style={styles.creationSubtitle}>However you find it, make a little room in your cookbook.</Text>
          </View>
          {options.map(option => (
            <GlassPressable key={option.mode} style={styles.creationOption} onPress={() => { hasWork.current = true; setCreationMode(option.mode); }} accessibilityLabel={option.title}>
              <View style={[styles.creationIcon, option.mode === 'generate' && styles.creationIconFeatured]}><Ionicons name={option.icon} size={25} color={primary} /></View>
              <View style={styles.creationCopy}>
                <Text style={styles.creationOptionTitle}>{option.title}</Text>
                <Text style={styles.creationOptionDescription}>{option.description}</Text>
              </View>
              <Ionicons name="chevron-forward" size={17} color={inkMuted} />
            </GlassPressable>
          ))}
        </View>
      );
    }

    if (creationMode === 'generate') {
      if (isImporting) {
        return (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={primary} />
            <Text style={styles.loadingText} accessibilityLiveRegion="polite">{importingMessage}</Text>
            <Text style={styles.loadingHint}>This can take a minute. You’ll review everything before saving.</Text>
            <GlassPressable style={styles.textButton} onPress={stopImport}><Text style={styles.textButtonText}>Cancel import</Text></GlassPressable>
          </View>
        );
      }
      return (
        <View style={styles.formSectionContainer}>
          <TextInput
            style={styles.formInput}
            placeholder="e.g. chicken katsu curry"
            placeholderTextColor={inkFaint}
            value={generateTitle}
            onChangeText={value => { hasWork.current = true; setGenerateTitle(value); }}
            multiline
          />
          <GlassPressable
            style={[styles.primaryButton, !generateTitle.trim() && styles.disabledButton]}
            onPress={handleGenerateRecipe}
            disabled={!generateTitle.trim()}
          >
            <Text style={styles.primaryButtonText}>Write Recipe</Text>
          </GlassPressable>
          <Text style={styles.photoHint}>
            Written fresh, so check it over before you save — you can edit every
            ingredient and step.
          </Text>
        </View>
      );
    }

    if (creationMode === 'photo') {
      if (isImporting) {
        return (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={primary} />
            <Text style={styles.loadingText} accessibilityLiveRegion="polite">{importingMessage}</Text>
            <Text style={styles.loadingHint}>This can take a minute. You’ll review everything before saving.</Text>
            <GlassPressable style={styles.textButton} onPress={stopImport}><Text style={styles.textButtonText}>Cancel import</Text></GlassPressable>
          </View>
        );
      }
      return (
        <>
          <GlassPressable
            style={[styles.selectionButton, isPickerBusy && styles.selectionButtonBusy]}
            onPress={() => handleImportFromPhoto('camera')}
            disabled={isPickerBusy}
          >
            <Ionicons name="camera-outline" size={32} color={primary} />
            <Text style={styles.selectionButtonTitle}>Take a Photo</Text>
            <Text style={styles.selectionButtonDescription}>Lay the page flat in good light and fill the frame.</Text>
          </GlassPressable>
          <GlassPressable
            style={[styles.selectionButton, isPickerBusy && styles.selectionButtonBusy]}
            onPress={() => handleImportFromPhoto('library')}
            disabled={isPickerBusy}
          >
            <Ionicons name="images-outline" size={32} color={primary} />
            <Text style={styles.selectionButtonTitle}>Choose an Image</Text>
            <Text style={styles.selectionButtonDescription}>Pick a photo or screenshot you already have.</Text>
          </GlassPressable>
          <Text style={styles.photoHint}>
            You&apos;ll get a chance to check everything before it&apos;s saved.
          </Text>
        </>
      );
    }

    if (creationMode === 'link') {
      // ✅ 3. If importing, show the animated loading screen. Otherwise, show the URL input.
      if (isImporting) {
        return (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={primary} />
            <Text style={styles.loadingText} accessibilityLiveRegion="polite">{importingMessage}</Text>
            <Text style={styles.loadingHint}>{isSocialImport
              ? 'Reading a video’s speech can take a couple of minutes. Keep this screen open; you’ll review everything before saving.'
              : 'This can take a minute. You’ll review everything before saving.'}</Text>
            <GlassPressable style={styles.textButton} onPress={stopImport}><Text style={styles.textButtonText}>Cancel import</Text></GlassPressable>
          </View>
        );
      }
      return (
        <View style={styles.formSectionContainer}>
          <View style={styles.linkTitleRow}><View style={styles.linkIcon}><Ionicons name="link-outline" size={24} color={primary} /></View><View style={styles.creationCopy}><Text style={styles.linkTitle}>Keep a delicious find</Text><Text style={styles.linkSubtitle}>TikTok · Instagram · Recipe websites</Text></View></View>
          <Text style={styles.linkDescription}>Copy the link from a public post or recipe page and paste it here. Shared captions with a link work too.</Text>
          <TextInput
            style={[styles.formInput, styles.linkInput]}
            placeholder="Paste a link or shared post…"
            placeholderTextColor={inkFaint}
            value={importUrl}
            onChangeText={value => { hasWork.current = true; setImportUrl(value); setImportProblem(null); }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            multiline
            accessibilityLabel="Recipe link or shared post"
          />
          {'url' in parsedImport && <View style={styles.linkPreview}><Ionicons name="checkmark-circle" size={16} color={primary} /><Text style={styles.linkPreviewText} numberOfLines={2}>{recipeSourceLabel(parsedImport.url)} · {new URL(parsedImport.url).pathname}</Text></View>}
          {importProblem && <View style={styles.problemCard} accessibilityLiveRegion="polite"><Text style={styles.problemTitle}>{importProblem.title}</Text><Text style={styles.problemText}>{importProblem.message}</Text></View>}
          <GlassPressable style={[styles.primaryButton, !importUrl.trim() && styles.disabledButton]} onPress={handleImportRecipe} disabled={!importUrl.trim()}>
            <Text style={styles.primaryButtonText}>{importProblem?.retryable ? 'Try again' : 'Find the recipe'}</Text>
          </GlassPressable>
          {importProblem && <GlassPressable style={styles.textButton} onPress={() => { setImportProblem(null); setCreationMode('photo'); }}><Ionicons name="images-outline" size={17} color={primary} /><Text style={styles.textButtonText}>Use a screenshot instead</Text></GlassPressable>}
          <Text style={styles.photoHint}>We’ll bring over the ingredients and steps. Check them, make any edits, then save to your cookbook.</Text>
        </View>
      );
    }

    if (creationMode === 'manual' && editingRecipe) {
      return (
        <>
            {isReviewingImport && <View style={styles.reviewBanner}><Ionicons name="checkmark-circle-outline" size={23} color={primary} /><View style={styles.creationCopy}><Text style={styles.reviewTitle}>Ready for your review</Text><Text style={styles.reviewText}>Check the ingredients, quantities, and steps before saving.{editingRecipe.sourceUrl ? ` From ${recipeSourceLabel(editingRecipe.sourceUrl)}${editingRecipe.sourceAuthor ? ` · ${editingRecipe.sourceAuthor}` : ''}.` : ''}</Text></View></View>}
            {saveProblem && <View style={[styles.problemCard, { marginHorizontal: 18 }]} accessibilityLiveRegion="polite"><Text style={styles.problemTitle}>Your draft is still here</Text><Text style={styles.problemText}>{saveProblem}</Text></View>}
            <View style={styles.formSectionContainer}>
              {editingRecipe.photoURL ? ( <GlassPressable onPress={handlePickImage}><Image source={{ uri: editingRecipe.photoURL }} style={styles.recipeImage} /><View style={styles.imageEditIcon}><Ionicons name="pencil" size={18} color="#fff" /></View></GlassPressable>
              ) : ( <GlassPressable style={[styles.recipeImage, styles.addImageButton]} onPress={handlePickImage}><Ionicons name="camera-outline" size={24} color={primary} /><Text style={styles.addImageButtonText}>Add Photo</Text></GlassPressable> )}
            </View>
            <View style={styles.formSectionContainer}>
              <TextInput style={styles.recipeNameInput} placeholder="Recipe Name" placeholderTextColor={inkFaint} value={editingRecipe.name} onChangeText={(val) => handleRecipeFieldChange('name', val)} multiline />
              <TextInput style={[styles.formInput, styles.descriptionInput]} placeholder="A short, tasty description..." placeholderTextColor={inkFaint} value={editingRecipe.description} onChangeText={(val) => handleRecipeFieldChange('description', val)} multiline />
            </View>
            <View style={styles.formSectionContainer}>
              {/* Servings lives in the ingredients header because that is what
                  it means: the number these amounts were written for. Anywhere
                  else and it reads as trivia about the dish. */}
              <View style={styles.sectionTitleRow}>
                <Text style={styles.formSectionTitle}>Ingredients</Text>
                <View style={styles.servingsField}>
                  <Text style={styles.servingsLabel}>Serves</Text>
                  <TextInput
                    style={styles.servingsInput}
                    placeholder="—"
                    placeholderTextColor={inkFaint}
                    value={editingRecipe.servings ? String(editingRecipe.servings) : ''}
                    onChangeText={handleServingsChange}
                    keyboardType="number-pad"
                    maxLength={2}
                  />
                </View>
              </View>
              {editingRecipe.ingredients.map((ing, index) => (
              <View key={`ing-${index}`} style={styles.formRow}><TextInput style={[styles.formInput, styles.quantityInput]} placeholder="1 cup" placeholderTextColor={inkFaint} value={ing.quantity} onChangeText={(val) => handleIngredientChange(index, 'quantity', val)} /><TextInput style={[styles.formInput, styles.nameInput]} placeholder="Flour" placeholderTextColor={inkFaint} value={ing.name} onChangeText={(val) => handleIngredientChange(index, 'name', val)} /><GlassPressable onPress={() => removeIngredientField(index)} style={styles.deleteRowButton}><Ionicons name="remove-circle-outline" size={24} color="#EF4444" /></GlassPressable></View>
              ))}
              <GlassPressable style={styles.addFieldButton} onPress={addIngredientField}><Ionicons name="add" size={20} color={primary} /><Text style={styles.addFieldButtonText}>Add Ingredient</Text></GlassPressable>
            </View>
            <View style={styles.formSectionContainer}>
              <Text style={styles.formSectionTitle}>Instructions</Text>
              {editingRecipe.instructions.map((inst, index) => (
              <View key={`inst-${index}`} style={[styles.formRow, styles.stepFormRow]}>
                {/* Same numbered column as the read view, so a step that grows to
                    several lines keeps its number pinned to the first one. */}
                <View style={styles.stepBadge}><Text style={styles.stepNumber}>{index + 1}</Text></View>
                <TextInput style={[styles.formInput, styles.nameInput]} placeholder="Mix the things..." placeholderTextColor={inkFaint} value={inst} onChangeText={(val) => handleInstructionChange(index, val)} multiline />
                <GlassPressable onPress={() => removeInstructionField(index)} style={[styles.deleteRowButton, styles.stepDeleteButton]}><Ionicons name="remove-circle-outline" size={24} color="#EF4444" /></GlassPressable>
              </View>
              ))}
              <GlassPressable style={styles.addFieldButton} onPress={addInstructionField}><Ionicons name="add" size={20} color={primary} /><Text style={styles.addFieldButtonText}>Add Step</Text></GlassPressable>
            </View>
            </>
      );
    }

    return null;
  };

    return (
    // Stepping aside on Android while a picker is being launched: this sheet is
    // a Dialog over the activity there, and asking for the camera permission
    // from behind one is where the launch gets stuck. iOS presents fine over
    // its own modal and keeps the sheet up.
    <Modal
      animationType={reduceMotion ? "none" : "slide"}
      visible={isVisible && !(Platform.OS === 'android' && isPickerBusy)}
      onRequestClose={() => confirmation ? setConfirmation(null) : requestClose()}
      onDismiss={() => { if (!visible.current) onDismiss?.(); }}
      transparent={true}
    >
      {/* The avoider has to be the FULL-SCREEN element, not the sheet. Wrapped
          around the sheet instead, `behavior="padding"` padded the inside of a
          content-sized box: the sheet simply grew downwards off the screen and
          nothing moved, so the keyboard sat on top of whatever you had just
          tapped. Out here it shrinks the space the sheet is bottom-aligned in,
          which lifts it. */}
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <SafeAreaView style={styles.modalSafeArea}>
            <View style={styles.modalContentContainer}>
              <GlassSurface style={styles.modalHeader} intensity={70}>
                {/* Header content remains the same */}
                {creationMode !== 'initial' && !isEditingExisting ? (
                  <GlassPressable onPress={handleBackPress} disabled={isSaving} style={styles.backButton} accessibilityLabel="Back to recipe options">
                    <Ionicons name="chevron-back" size={21} color={ink} />
                  </GlassPressable>
                ) : <View style={styles.backButton} /> }
                <Text style={styles.modalTitle}>{isReviewingImport ? 'Review' : isEditingExisting ? 'Edit' : 'Add'} Recipe</Text>
                <GlassPressable onPress={requestClose} disabled={isSaving} style={styles.closeButton} accessibilityLabel="Close recipe editor">
                  <Ionicons name="close" size={21} color={ink} />
                </GlassPressable>
              </GlassSurface>
              
              {/* No fixed height. `height: height * 0.7` was measured against the
                  whole screen, so with the keyboard up the sheet was taller
                  than the space left for it and its top — the header, the
                  Cancel/Save row — was pushed off, leaving a full screen of
                  form background. flexShrink lets it give way instead. */}
              <ScrollView
                ref={keyboard.scrollRef}
                {...keyboard.scrollProps}
                style={styles.modalScrollView}
                // The avoider above lifts the sheet clear of the keyboard, which
                // shrinks this form rather than covering it — so a field near the
                // bottom ends up below the fold instead of behind the keyboard,
                // and something still has to scroll it back into sight.
                contentContainerStyle={[styles.modalScrollViewContent, { paddingBottom: keyboard.keyboardSpace }]}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
              >
                {pendingShare && <View style={styles.pendingShare}><Ionicons name="link-outline" size={21} color={primary} /><View style={styles.creationCopy}><Text style={styles.reviewTitle}>A shared link is waiting</Text><Text style={styles.reviewText}>Your current draft is safe.</Text></View><GlassPressable style={styles.pendingShareButton} onPress={reviewPendingShare} disabled={isSaving}><Text style={styles.textButtonText}>Review</Text></GlassPressable></View>}
                <View pointerEvents={isSaving ? 'none' : 'auto'}>{renderContent()}</View>
              </ScrollView>

              {/* ✅ 4. Hide footer during initial selection and while importing */}
              {!isImporting && (creationMode === 'manual') && (
                <GlassSurface style={styles.modalFooter} intensity={70}>
                  <GlassPressable style={styles.secondaryButton} onPress={requestClose} disabled={isSaving}><Text style={styles.secondaryButtonText}>Cancel</Text></GlassPressable>
                  <GlassPressable style={[styles.primaryButton, isSaveDisabled && styles.disabledButton]} onPress={handleSaveRecipe} disabled={isSaveDisabled}>
                    {isSaving ? <ActivityIndicator color="#FFFFFF" accessibilityLabel="Saving recipe" /> : <Text style={styles.primaryButtonText}>{isEditingExisting ? 'Save changes' : mealForRecipe ? 'Save recipe' : 'Save to cookbook'}</Text>}
                  </GlassPressable>
                </GlassSurface>
              )}
            </View>
        </SafeAreaView>
        {confirmation && <View style={styles.confirmOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setConfirmation(null)} accessibilityLabel="Keep editing" />
          <GlassSurface style={styles.confirmCard} intensity={80} accessibilityViewIsModal>
            <Text style={styles.confirmTitle}>{confirmation.title}</Text>
            <Text style={styles.confirmMessage}>{confirmation.message}</Text>
            <View style={styles.confirmActions}>
              <GlassPressable style={styles.confirmCancel} onPress={() => setConfirmation(null)}><Text style={styles.textButtonText}>Keep editing</Text></GlassPressable>
              <GlassPressable style={styles.confirmDiscard} onPress={() => { const action = confirmation.confirm; setConfirmation(null); action(); }}><Text style={styles.confirmDiscardText}>{confirmation.label}</Text></GlassPressable>
            </View>
          </GlassSurface>
        </View>}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Align the overlay content to the bottom
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,37,28,0.32)',
    justifyContent: 'flex-end',
  },
  // React Native defaults flexShrink to 0, so without these three the sheet
  // refuses to give up any height and overflows the screen the moment the
  // keyboard takes half of it.
  modalSafeArea: {
    width: '100%',
    maxHeight: '94%',
    flexShrink: 1,
  },
  modalScrollView: {
    flexGrow: 0,
    flexShrink: 1,
  },
  modalScrollViewContent: { paddingTop: 16 },
  modalContentContainer: {
    backgroundColor: '#F5F5EF',
    borderTopLeftRadius: 34,
    borderTopRightRadius: 34,
    overflow: 'hidden',
    flexShrink: 1,
  },
  modalHeader: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 0,
    borderWidth: 0,
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  modalTitle: { fontSize: 19, fontWeight: '700', letterSpacing: -0.6, color: ink, textAlign: 'center'},
  backButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  closeButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E5EDE3' },
  formSectionContainer: { backgroundColor: 'rgba(255,255,255,0.78)', borderRadius: 25, margin: 18, padding: 18, marginTop: 0, borderWidth: 1, borderColor: '#FFF' },
  formSectionTitle: { fontSize: 19, fontWeight: '700', letterSpacing: -0.5, color: ink, marginBottom: 17 },
  // The heading keeps its own marginBottom, so the row aligns on the text
  // baseline rather than on the box.
  sectionTitleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  servingsField: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -6 },
  servingsLabel: { fontSize: 13, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', color: inkMuted },
  servingsInput: { minWidth: 44, textAlign: 'center', paddingVertical: 4, paddingHorizontal: 8, borderRadius: 8, backgroundColor: accentSoft, color: ink, fontSize: 15, fontWeight: '700' },
  formInput: { color: ink, borderWidth: 1, borderColor: hairline, borderRadius: 16, padding: 13, fontSize: 15, marginBottom: 12, backgroundColor: '#F8FAF4' },
  recipeNameInput: { fontSize: 24, fontWeight: '700', letterSpacing: -0.4, marginBottom: 8, borderBottomWidth: 1, borderColor: hairline, paddingBottom: 8, color: ink },
  descriptionInput: { minHeight: 80, textAlignVertical: 'top' },
  formRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  quantityInput: { flex: 0.3, marginRight: 8 },
  nameInput: { flex: 1 },
  photoHint: { textAlign: 'center', color: inkMuted, fontSize: 13, lineHeight: 21, marginTop: 14, paddingHorizontal: 12, marginBottom: 12 },
  stepFormRow: { alignItems: 'flex-start' },
  stepBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: accentSoft, alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 6 },
  stepNumber: { fontSize: 13, fontWeight: '700', color: primary },
  stepDeleteButton: { marginTop: 8 },
  deleteRowButton: { padding: 4, marginLeft: 8 },
  addFieldButton: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', paddingVertical: 8 },
  addFieldButtonText: { color: primary, fontSize: 16, fontWeight: '600', marginLeft: 4 },
  modalFooter: { flexDirection: 'row', justifyContent: 'space-between', padding: 8, margin: 12, borderRadius: 30 },
  primaryButton: { backgroundColor: primary, paddingVertical: 15, borderRadius: 23, alignItems: 'center', flex: 1, justifyContent: 'center', minHeight: 50 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  secondaryButton: { backgroundColor: '#E5EDE3', paddingVertical: 15, borderRadius: 23, alignItems: 'center', flex: 1, marginRight: 10 },
  secondaryButtonText: { color: ink, fontSize: 16, fontWeight: 'bold' },
  disabledButton: { opacity: 0.6 },
  recipeImage: { width: '100%', aspectRatio: 16 / 9, borderRadius: 23, backgroundColor: '#E5EDE3', resizeMode: 'cover' },
  addImageButton: { justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: hairline, borderStyle: 'dashed' },
  addImageButtonText: { marginTop: 8, color: primary, fontWeight: '600' },
  imageEditIcon: { position: 'absolute', bottom: 10, right: 10, backgroundColor: 'rgba(0,0,0,0.5)', padding: 8, borderRadius: 16 },
  selectionButton: {
    backgroundColor: '#FFFFFF',
    borderRadius: 27,
    padding: 25,
    margin: 16,
    marginTop: 0,
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 5,
    elevation: 3,
  },
  // The camera can take a second to come up, and a button that looks untouched
  // in that second reads as a button that didn't work.
  selectionButtonBusy: { opacity: 0.5 },
  selectionButtonTitle: { fontSize: 20, fontWeight: 'bold', color: primary, marginTop: 12, marginBottom: 6 },
  selectionButtonDescription: { fontSize: 14, lineHeight: 21, color: inkMuted, textAlign: 'center' },
  iconRow: { flexDirection: 'row', gap: 16 },
  creationIntro: { paddingHorizontal: 24, paddingTop: 7, paddingBottom: 24 },
  creationEyebrow: { fontSize: 9, fontWeight: '700', letterSpacing: 1.8, color: inkMuted, marginBottom: 8 },
  creationTitle: { fontSize: 30, lineHeight: 35, fontWeight: '700', letterSpacing: -1.2, color: ink },
  creationSubtitle: { fontSize: 14, lineHeight: 22, color: inkMuted, marginTop: 10 },
  creationOption: { flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: 'rgba(255,255,255,0.85)', borderWidth: 1, borderColor: '#FFF', borderRadius: 26, padding: 17, marginHorizontal: 18, marginBottom: 12 },
  creationIcon: { width: 48, height: 48, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E5EDE3' },
  creationIconFeatured: { backgroundColor: '#EEDACE' },
  creationCopy: { flex: 1 },
  creationOptionTitle: { fontSize: 16, fontWeight: '700', color: ink, letterSpacing: -0.4 },
  creationOptionDescription: { fontSize: 12, lineHeight: 18, color: inkMuted, marginTop: 4 },
  confirmOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(15,37,28,0.35)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  confirmCard: { width: '100%', maxWidth: 370, padding: 24, borderRadius: 28, backgroundColor: 'rgba(248,250,243,0.96)' },
  confirmTitle: { fontSize: 23, fontWeight: '700', color: ink, letterSpacing: -0.6 },
  confirmMessage: { fontSize: 14, lineHeight: 22, color: inkMuted, marginTop: 12 },
  confirmActions: { flexDirection: 'row', gap: 10, marginTop: 24 },
  confirmCancel: { flex: 1, minHeight: 46, borderRadius: 18, backgroundColor: accentSoft, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  confirmDiscard: { flex: 1, minHeight: 46, borderRadius: 18, backgroundColor: '#A54F42', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  confirmDiscardText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  linkTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 15 },
  linkIcon: { width: 46, height: 46, borderRadius: 17, backgroundColor: accentSoft, alignItems: 'center', justifyContent: 'center' },
  linkTitle: { fontSize: 19, fontWeight: '700', color: ink, letterSpacing: -0.5 },
  linkSubtitle: { fontSize: 11, color: inkMuted, marginTop: 5 },
  linkDescription: { color: inkMuted, fontSize: 13, lineHeight: 20, marginBottom: 17 },
  linkInput: { minHeight: 100, textAlignVertical: 'top' },
  linkPreview: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 16 },
  linkPreviewText: { flex: 1, fontSize: 12, color: primary, lineHeight: 18 },
  problemCard: { padding: 15, borderRadius: 18, backgroundColor: '#F5E8DF', marginBottom: 15 },
  problemTitle: { fontSize: 14, fontWeight: '700', color: ink, marginBottom: 6 },
  problemText: { fontSize: 13, lineHeight: 20, color: inkMuted },
  textButton: { minHeight: 44, paddingHorizontal: 8, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7 },
  textButtonText: { fontSize: 13, fontWeight: '600', color: primary },
  loadingHint: { fontSize: 13, lineHeight: 20, color: inkMuted, textAlign: 'center', marginTop: 12, marginBottom: 9 },
  reviewBanner: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, marginHorizontal: 18, marginBottom: 16, padding: 16, borderRadius: 21, backgroundColor: '#E2EDDF' },
  reviewTitle: { fontSize: 14, fontWeight: '600', color: ink, marginBottom: 4 },
  reviewText: { fontSize: 12, lineHeight: 19, color: inkMuted },
  pendingShare: { flexDirection: 'row', gap: 10, alignItems: 'center', marginHorizontal: 18, marginBottom: 15, padding: 14, borderRadius: 20, borderWidth: 1, borderColor: '#CEDFC9', backgroundColor: '#E8F0E4' },
  pendingShareButton: { paddingHorizontal: 9, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  // The loading stage stays cancellable; extracted content always opens for review.
  loadingContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    minHeight: 250,
  },
  loadingText: {
    marginTop: 20,
    fontSize: 18,
    color: inkMuted,
    fontWeight: '600',
    textAlign: 'center',
  },
});
