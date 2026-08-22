import { Ingredient, Item, Meal, Recipe } from '@/types/types';
import { accentSoft, hairline, ink, inkFaint, inkMuted, primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Image, Keyboard, KeyboardAvoidingView, Linking, Modal, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import uuid from 'react-native-uuid';
import { generateRecipeFromTitle, getRecipe, importRecipeFromPhoto, importRecipeFromUrl, saveRecipe, uploadRecipePhoto } from '../utils/api';
import { useAuth } from '@/context/AuthContext';
import { parseServings, scaleIngredients, servingsScale } from '@/utils/servings';

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
  onRecipeSave: (updatedMeal: Meal | null, newItems: Item[], savedRecipe: Recipe) => void;
}

export default function AddEditRecipeModal({ isVisible, onClose, mealForRecipe, recipeToEdit = null, onRecipeSave }: AddEditRecipeModalProps) {
  const { selectedGroup } = useAuth();
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
  const [isSaveDisabled, setIsSaveDisabled] = useState(true);

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
  
  useEffect(() => {
    // Enable the save button only if the user is in the manual editing
    // mode and the recipe has a name.
    if (creationMode === 'manual' && editingRecipe?.name?.trim()) {
      setIsSaveDisabled(false);
    } else {
      // Otherwise, keep it disabled.
      setIsSaveDisabled(true);
    }
    // Rerun this logic whenever the recipe data or the creation mode changes.
  }, [editingRecipe, creationMode]);

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
        }, 3000); // Change message every 3 seconds
    }

    // Cleanup function to clear the interval
    return () => {
        if (interval) {
            clearInterval(interval);
        }
    };
  }, [isImporting, importSource]);

  useEffect(() => {
    if (!isVisible) {
      setEditingRecipe(null);
      return;
    }

    const setupRecipe = async () => {
      setIsLoading(true);
      setImportUrl('');
      setGenerateTitle(mealForRecipe?.name || '');

      // Handed a recipe outright — the cookbook's Edit already has it.
      if (recipeToEdit) {
        setCreationMode('manual');
        setEditingRecipe(recipeToEdit);
      } else if (mealForRecipe?.recipeId) {
        setCreationMode('manual');
        try {
          const existingRecipe = await getRecipe(mealForRecipe.recipeId);
          setEditingRecipe(existingRecipe);
        } catch (e) {
          console.error("Failed to fetch recipe for editing", e);
          Alert.alert("Error", "Could not load the recipe to edit.");
          onClose();
        }
      } else {
        // No meal and no recipe: a blank one, headed for the cookbook.
        setCreationMode('initial');
        setEditingRecipe(createBlankRecipe());
      }
      setIsLoading(false);
    };

    setupRecipe();
  }, [isVisible, mealForRecipe, recipeToEdit]);

  const handleImportRecipe = async () => {
    if (!importUrl) return;
    Keyboard.dismiss();
    setImportSource('link');
    setIsImporting(true);
    try {
      const importedRecipe = await importRecipeFromUrl(importUrl);
      // On successful import, go to the manual editing mode with the imported data
      setEditingRecipe(prev => ({ ...importedRecipe, id: prev!.id }));
      setCreationMode('manual');
    } catch (error: any) {
      console.error("Failed to import recipe", error);
      // The importer names its failures now, and they want different advice:
      // a page with no recipe on it is the user's link to fix, a video we
      // couldn't open is not.
      const code = typeof error?.message === 'string' ? error.message : '';
      const [title, body] =
        code.includes('RECIPE_NOT_FOUND')
          ? ['No recipe found', "That page doesn't seem to have a recipe on it. Try a different link."]
        : code.includes('VIDEO_UNAVAILABLE')
          ? ["Couldn't read that video", 'It may be private, deleted, or unavailable in your region.']
        : code.includes('FETCH_FAILED')
          ? ["Couldn't open that link", "The site didn't respond. Check the link, or try again in a moment."]
        : code.includes('NO_CONTENT')
          ? ['Nothing to read there', "That page didn't have any recipe text on it. Try the recipe's own page."]
        : ['Import failed', "Couldn't get the recipe from that URL. Please try a different link."];

      // A screenshot always works, and on a cooking video it is the *best*
      // input we have — the ingredient overlay a video puts on screen is
      // exactly what the photo importer is good at reading.
      Alert.alert(title, body, [
        { text: 'Back', style: 'cancel' },
        { text: 'Use a screenshot', onPress: () => setCreationMode('photo') },
      ]);
    } finally {
      setIsImporting(false);
    }
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
    source: 'camera' | 'library'
  ): Promise<ImagePicker.ImagePickerResult | null> => {
    if (source === 'camera') {
      // A plain read. It never reaches Activity.requestPermissions, so unlike a
      // request it cannot be the thing that gets stuck.
      let permission = await ImagePicker.getCameraPermissionsAsync();

      // Who does the asking is the whole point: iOS won't open the camera
      // without the permission already in hand, so it is asked for here.
      // Android's launcher asks for itself, and asking on top of that is what
      // strands the request — so there, don't.
      if (!permission.granted && permission.canAskAgain && Platform.OS !== 'android') {
        permission = await ImagePicker.requestCameraPermissionsAsync();
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
      cameraDenied(permission?.canAskAgain ?? false);
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
    // The camera takes a moment to come up, and a second tap in that moment
    // asks for a second one. It also gives the tap something to show for
    // itself, which is what "nothing happens" was really reporting.
    if (isPickerBusy) return;
    setIsPickerBusy(true);
    let result: ImagePicker.ImagePickerResult | null;
    try {
      // On Android this sheet is a Dialog sitting over the activity, and the
      // camera permission is what gets stuck behind it. `isPickerBusy` takes
      // the sheet off the screen; this waits for it to actually go before the
      // OS is asked for anything.
      if (Platform.OS === 'android') await new Promise(resolve => setTimeout(resolve, SHEET_DISMISS_MS));
      result = await openRecipePhotoPicker(source);
    } finally {
      setIsPickerBusy(false);
    }

    if (!result || result.canceled) return;
    const asset = result.assets?.[0];
    if (!asset?.base64) {
      Alert.alert('Error', "Couldn't read that image. Please try again.");
      return;
    }

    setImportSource('photo');
    setIsImporting(true);
    try {
      const mime = asset.mimeType?.startsWith('image/') ? asset.mimeType : 'image/jpeg';
      const imported = await importRecipeFromPhoto(`data:${mime};base64,${asset.base64}`);
      setEditingRecipe(prev => ({ ...imported, id: prev!.id }));
      setCreationMode('manual');
    } catch (error: any) {
      console.error('Failed to import recipe from photo', error);
      const notARecipe = typeof error?.message === 'string' && error.message.includes('RECIPE_NOT_FOUND');
      Alert.alert(
        notARecipe ? 'No recipe found' : 'Import failed',
        notARecipe
          ? "That photo doesn't look like a recipe. Try a clearer shot of the page."
          : "Couldn't read the recipe from that photo. Try again with more light, or enter it manually."
      );
    } finally {
      setIsImporting(false);
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
    if (!title) return;
    Keyboard.dismiss();
    setImportSource('generate');
    setIsImporting(true);
    try {
      // Written for this household from the start. There is no source document
      // to be faithful to here, so the quantities can simply be the right ones
      // rather than four portions scaled down on their way to the list.
      const generated = await generateRecipeFromTitle(title, selectedGroup?.householdSize);
      setEditingRecipe(prev => ({ ...generated, id: prev!.id }));
      setCreationMode('manual');
    } catch (error: any) {
      console.error('Failed to generate recipe', error);
      const notFood = typeof error?.message === 'string' && error.message.includes('RECIPE_NOT_FOUND');
      Alert.alert(
        notFood ? "That doesn't sound like a dish" : 'Could not write that recipe',
        notFood
          ? "We couldn't tell what to cook from that. Try naming a dish, like \"chicken katsu curry\"."
          : 'Something went wrong writing that recipe. Please try again.'
      );
    } finally {
      setIsImporting(false);
    }
  };

  const handleBackPress = () => {
    // Go back to the initial selection from any other state
    if (creationMode !== 'initial') {
      // Leaving the photo step with a launch still marked in flight would come
      // back to two dead buttons, which is the failure this was added to make
      // visible rather than one to reproduce.
      setIsPickerBusy(false);
      setCreationMode('initial');
      // Reset to a blank slate in case of a bad import
      setEditingRecipe(createBlankRecipe());
      setImportUrl('');
      setGenerateTitle(mealForRecipe?.name || '');
    }
  };

  const handleSaveRecipe = async () => {
    if (!editingRecipe) return;
    if(editingRecipe.photoURL && !editingRecipe.photoURL.startsWith('http')) {
      try {
        editingRecipe.photoURL = await uploadRecipePhoto(editingRecipe.photoURL, editingRecipe.id);
      } catch(e) { console.error("Failed to upload photo", e); Alert.alert("Error", "Could not upload photo."); return; }
    }
    try {
      const recipeToSave = { ...editingRecipe, ingredients: (editingRecipe.ingredients || []).filter(i => (i.name ?? '').trim() !== ''), instructions: (editingRecipe.instructions || []).filter(i => (i ?? '').trim() !== '') };
      const savedRecipe = await saveRecipe(recipeToSave);
      // A cookbook recipe has no meal to point back at and nothing to shop for.
      const updatedMeal = mealForRecipe
        ? { ...mealForRecipe, recipeId: savedRecipe.id, name: savedRecipe.name }
        : null;
      // The one moment scaling is applied: a recipe's ingredients becoming rows
      // on a shopping list. The recipe itself was saved above, unscaled and
      // unchanged — see packages/shared/servings.ts for why that matters.
      const scale = servingsScale(savedRecipe.servings, selectedGroup?.householdSize);
      const newItemsForRecipe = mealForRecipe
        ? scaleIngredients(savedRecipe.ingredients, scale).map(ing => ({ id: uuid.v4() as string, text: ing.name.trim(), quantity: (ing.quantity ?? '').trim(), checked: false, listOrder: 'NEEDS-RANK', isSection: false, mealId: mealForRecipe.id }))
        : [];
      // Recorded on the meal so the cooking view shows the amounts the shop was
      // actually done against, even if the household size changes later.
      if (updatedMeal && scale !== 1) updatedMeal.scale = scale;
      onRecipeSave(updatedMeal, newItemsForRecipe, savedRecipe);
      onClose();
    } catch (error) { console.error("Failed to save recipe", error); Alert.alert("Error", "Could not save recipe."); }
  };

  const handlePickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { Alert.alert('Permission needed', 'Sorry, we need camera roll permissions to add a photo.'); return; }
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [16, 9], quality: 0.7 });
      if (!result.canceled && result.assets[0].uri) { handleRecipeFieldChange('photoURL', result.assets[0].uri); }
    } catch (error) {
      console.error('Failed to open the image picker', error);
      Alert.alert("Couldn't open your photos", 'Please try again.');
    }
  };

  const handleRecipeFieldChange = (field: keyof Recipe, value: string) => setEditingRecipe(p => p ? { ...p, [field]: value } : null);
  /**
   * Servings is a number on the contract, and the field it comes from is a
   * keyboard. An unreadable or empty box clears it rather than storing 0 —
   * absent means "don't scale", and a 0 would be a division by nothing.
   */
  const handleServingsChange = (value: string) => setEditingRecipe(p => {
    if (!p) return null;
    const next = { ...p };
    const parsed = parseServings(value);
    if (parsed) next.servings = parsed;
    else delete next.servings;
    return next;
  });
  const handleIngredientChange = (index: number, field: keyof Ingredient, value: string) => setEditingRecipe(p => { if (!p) return null; const ni = [...p.ingredients]; ni[index] = { ...ni[index], [field]: value }; return { ...p, ingredients: ni }; });
  const addIngredientField = () => setEditingRecipe(p => p ? { ...p, ingredients: [...p.ingredients, { name: '', quantity: '' }] } : null);
  const removeIngredientField = (index: number) => setEditingRecipe(p => p ? { ...p, ingredients: p.ingredients.filter((_, i) => i !== index) } : null);
  const handleInstructionChange = (index: number, value: string) => setEditingRecipe(p => { if (!p) return null; const ni = [...p.instructions]; ni[index] = value; return { ...p, instructions: ni }; });
  const addInstructionField = () => setEditingRecipe(p => p ? { ...p, instructions: [...p.instructions, ''] } : null);
  const removeInstructionField = (index: number) => setEditingRecipe(p => p ? { ...p, instructions: p.instructions.filter((_, i) => i !== index) } : null);

  const renderContent = () => {
    if (isLoading) return <ActivityIndicator style={{ marginTop: 40 }} size="large" />;
    
    if (creationMode === 'initial') {
      return (
        <>
          {/* Named by SOURCE rather than by mechanism. Both of the first two
              are automatic imports, so calling one "Automatic Import" made the
              photo option read like something else entirely. */}
          {/* First, because the common path into this modal is a meal that
              already has a name — at that point the fastest route to a recipe
              is to write one, not to go hunting for a link to a dish they can
              already name. Called "Write" rather than "Find": it is made up on
              the spot, and the copy shouldn't imply we went and looked. */}
          <TouchableOpacity style={styles.selectionButton} onPress={() => setCreationMode('generate')}>
            <Ionicons name="sparkles-outline" size={32} color={primary} />
            <Text style={styles.selectionButtonTitle}>Write Me a Recipe</Text>
            <Text style={styles.selectionButtonDescription}>
              {mealForRecipe?.name?.trim()
                ? `Ingredients and steps for ${mealForRecipe.name.trim()}, written for you.`
                : 'Name a dish and get the ingredients and steps, written for you.'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.selectionButton} onPress={() => setCreationMode('link')}>
            <View style={styles.iconRow}><Ionicons name="globe-outline" size={32} color={primary} /><Ionicons name="logo-tiktok" size={32} color={primary} /></View>
            <Text style={styles.selectionButtonTitle}>Import from Link</Text>
            <Text style={styles.selectionButtonDescription}>Paste a link from a recipe website or TikTok.</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.selectionButton} onPress={() => setCreationMode('photo')}>
            <View style={styles.iconRow}><Ionicons name="camera-outline" size={32} color={primary} /><Ionicons name="document-text-outline" size={32} color={primary} /></View>
            <Text style={styles.selectionButtonTitle}>Import from Photo</Text>
            <Text style={styles.selectionButtonDescription}>Snap a cookbook page, recipe card, or handwritten note.</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.selectionButton} onPress={() => setCreationMode('manual')}>
            <Ionicons name="create-outline" size={32} color={primary} />
            <Text style={styles.selectionButtonTitle}>Enter Manually</Text>
            <Text style={styles.selectionButtonDescription}>Type the recipe in yourself, step-by-step.</Text>
          </TouchableOpacity>
        </>
      );
    }
    
    if (creationMode === 'generate') {
      if (isImporting) {
        return (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={primary} />
            <Text style={styles.loadingText}>{importingMessage}</Text>
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
            onChangeText={setGenerateTitle}
            multiline
          />
          <TouchableOpacity
            style={[styles.primaryButton, !generateTitle.trim() && styles.disabledButton]}
            onPress={handleGenerateRecipe}
            disabled={!generateTitle.trim()}
          >
            <Text style={styles.primaryButtonText}>Write Recipe</Text>
          </TouchableOpacity>
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
            <Text style={styles.loadingText}>{importingMessage}</Text>
          </View>
        );
      }
      return (
        <>
          <TouchableOpacity
            style={[styles.selectionButton, isPickerBusy && styles.selectionButtonBusy]}
            onPress={() => handleImportFromPhoto('camera')}
            disabled={isPickerBusy}
          >
            <Ionicons name="camera-outline" size={32} color={primary} />
            <Text style={styles.selectionButtonTitle}>Take a Photo</Text>
            <Text style={styles.selectionButtonDescription}>Lay the page flat in good light and fill the frame.</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.selectionButton, isPickerBusy && styles.selectionButtonBusy]}
            onPress={() => handleImportFromPhoto('library')}
            disabled={isPickerBusy}
          >
            <Ionicons name="images-outline" size={32} color={primary} />
            <Text style={styles.selectionButtonTitle}>Choose an Image</Text>
            <Text style={styles.selectionButtonDescription}>Pick a photo or screenshot you already have.</Text>
          </TouchableOpacity>
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
            <Text style={styles.loadingText}>{importingMessage}</Text>
          </View>
        );
      }
      return (
        <View style={styles.formSectionContainer}>
          <TextInput style={styles.formInput} placeholder="Paste a recipe link..." placeholderTextColor={inkFaint} value={importUrl} onChangeText={setImportUrl} autoCapitalize="none" keyboardType="url" />
          <TouchableOpacity style={styles.primaryButton} onPress={handleImportRecipe}>
            <Text style={styles.primaryButtonText}>Import</Text>
          </TouchableOpacity>
        </View>
      );
    }
    
    if (creationMode === 'manual' && editingRecipe) {
      return (
        <>
            <View style={styles.formSectionContainer}>
              {editingRecipe.photoURL ? ( <TouchableOpacity onPress={handlePickImage}><Image source={{ uri: editingRecipe.photoURL }} style={styles.recipeImage} /><View style={styles.imageEditIcon}><Ionicons name="pencil" size={18} color="#fff" /></View></TouchableOpacity>
              ) : ( <TouchableOpacity style={[styles.recipeImage, styles.addImageButton]} onPress={handlePickImage}><Ionicons name="camera-outline" size={24} color={primary} /><Text style={styles.addImageButtonText}>Add Photo</Text></TouchableOpacity> )}
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
              <View key={`ing-${index}`} style={styles.formRow}><TextInput style={[styles.formInput, styles.quantityInput]} placeholder="1 cup" placeholderTextColor={inkFaint} value={ing.quantity} onChangeText={(val) => handleIngredientChange(index, 'quantity', val)} /><TextInput style={[styles.formInput, styles.nameInput]} placeholder="Flour" placeholderTextColor={inkFaint} value={ing.name} onChangeText={(val) => handleIngredientChange(index, 'name', val)} /><TouchableOpacity onPress={() => removeIngredientField(index)} style={styles.deleteRowButton}><Ionicons name="remove-circle-outline" size={24} color="#EF4444" /></TouchableOpacity></View>
              ))}
              <TouchableOpacity style={styles.addFieldButton} onPress={addIngredientField}><Ionicons name="add" size={20} color={primary} /><Text style={styles.addFieldButtonText}>Add Ingredient</Text></TouchableOpacity>
            </View>
            <View style={styles.formSectionContainer}>
              <Text style={styles.formSectionTitle}>Instructions</Text>
              {editingRecipe.instructions.map((inst, index) => (
              <View key={`inst-${index}`} style={[styles.formRow, styles.stepFormRow]}>
                {/* Same numbered column as the read view, so a step that grows to
                    several lines keeps its number pinned to the first one. */}
                <View style={styles.stepBadge}><Text style={styles.stepNumber}>{index + 1}</Text></View>
                <TextInput style={[styles.formInput, styles.nameInput]} placeholder="Mix the things..." placeholderTextColor={inkFaint} value={inst} onChangeText={(val) => handleInstructionChange(index, val)} multiline />
                <TouchableOpacity onPress={() => removeInstructionField(index)} style={[styles.deleteRowButton, styles.stepDeleteButton]}><Ionicons name="remove-circle-outline" size={24} color="#EF4444" /></TouchableOpacity>
              </View>
              ))}
              <TouchableOpacity style={styles.addFieldButton} onPress={addInstructionField}><Ionicons name="add" size={20} color={primary} /><Text style={styles.addFieldButtonText}>Add Step</Text></TouchableOpacity>
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
      animationType="slide"
      visible={isVisible && !(Platform.OS === 'android' && isPickerBusy)}
      onRequestClose={onClose}
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
              <View style={styles.modalHeader}>
                {/* Header content remains the same */}
                {creationMode !== 'initial' && !isEditingExisting ? (
                  <TouchableOpacity onPress={handleBackPress} style={styles.backButton}>
                    <Ionicons name="chevron-back" size={28} color="#aaa" />
                  </TouchableOpacity>
                ) : <View style={styles.backButton} /> }
                <Text style={styles.modalTitle}>{isEditingExisting ? 'Edit' : 'Add'} Recipe</Text>
                <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                  <Ionicons name="close-circle" size={28} color="#aaa" />
                </TouchableOpacity>
              </View>
              
              {/* No fixed height. `height: height * 0.7` was measured against the
                  whole screen, so with the keyboard up the sheet was taller
                  than the space left for it and its top — the header, the
                  Cancel/Save row — was pushed off, leaving a full screen of
                  form background. flexShrink lets it give way instead. */}
              <ScrollView
                style={styles.modalScrollView}
                contentContainerStyle={styles.modalScrollViewContent}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
              >
                {renderContent()}
              </ScrollView>

              {/* ✅ 4. Hide footer during initial selection and while importing */}
              {!isImporting && (creationMode === 'manual') && (
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.secondaryButton} onPress={onClose}><Text style={styles.secondaryButtonText}>Cancel</Text></TouchableOpacity>
                  <TouchableOpacity style={[styles.primaryButton, isSaveDisabled && styles.disabledButton]} onPress={handleSaveRecipe} disabled={isSaveDisabled}>
                    <Text style={styles.primaryButtonText}>Save Recipe</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Align the overlay content to the bottom
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'flex-end',
  },
  // React Native defaults flexShrink to 0, so without these three the sheet
  // refuses to give up any height and overflows the screen the moment the
  // keyboard takes half of it.
  modalSafeArea: {
    width: '100%',
    flexShrink: 1,
  },
  modalScrollView: {
    flexGrow: 0,
    flexShrink: 1,
  },
  modalScrollViewContent: { paddingTop: 16 },
  modalContentContainer: {
    backgroundColor: '#F7F7F7',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
    flexShrink: 1,
  },
  modalHeader: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1, 
    borderBottomColor: '#EFEFEF',
    backgroundColor: '#FFFFFF',
  },
  modalTitle: { fontSize: 22, fontWeight: 'bold', textAlign: 'center'},
  backButton: { width: 30, alignItems: 'flex-start' },
  closeButton: { width: 30, alignItems: 'flex-end' },
  formSectionContainer: { backgroundColor: '#FFFFFF', borderRadius: 12, margin: 16, padding: 16, marginTop: 0, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
  formSectionTitle: { fontSize: 13, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', color: inkMuted, marginBottom: 14 },
  // The heading keeps its own marginBottom, so the row aligns on the text
  // baseline rather than on the box.
  sectionTitleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  servingsField: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -6 },
  servingsLabel: { fontSize: 13, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', color: inkMuted },
  servingsInput: { minWidth: 44, textAlign: 'center', paddingVertical: 4, paddingHorizontal: 8, borderRadius: 8, backgroundColor: accentSoft, color: ink, fontSize: 15, fontWeight: '700' },
  formInput: { color: ink, borderWidth: 1, borderColor: hairline, borderRadius: 10, padding: 12, fontSize: 16, marginBottom: 12 },
  recipeNameInput: { fontSize: 24, fontWeight: '700', letterSpacing: -0.4, marginBottom: 8, borderBottomWidth: 1, borderColor: hairline, paddingBottom: 8, color: ink },
  descriptionInput: { minHeight: 80, textAlignVertical: 'top' },
  formRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  quantityInput: { flex: 0.3, marginRight: 8 },
  nameInput: { flex: 1 },
  photoHint: { textAlign: 'center', color: inkMuted, fontSize: 14, marginTop: 8, paddingHorizontal: 12 },
  stepFormRow: { alignItems: 'flex-start' },
  stepBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: accentSoft, alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 6 },
  stepNumber: { fontSize: 13, fontWeight: '700', color: primary },
  stepDeleteButton: { marginTop: 8 },
  deleteRowButton: { padding: 4, marginLeft: 8 },
  addFieldButton: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', paddingVertical: 8 },
  addFieldButtonText: { color: primary, fontSize: 16, fontWeight: '600', marginLeft: 4 },
  modalFooter: { flexDirection: 'row', justifyContent: 'space-between', padding: 16, borderTopWidth: 1, borderTopColor: '#EFEFEF', backgroundColor: '#FFFFFF' },
  primaryButton: { backgroundColor: primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center', flex: 1, justifyContent: 'center', minHeight: 50 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  secondaryButton: { backgroundColor: '#EFEFEF', paddingVertical: 14, borderRadius: 12, alignItems: 'center', flex: 1, marginRight: 10 },
  secondaryButtonText: { color: '#333', fontSize: 16, fontWeight: 'bold' },
  disabledButton: { opacity: 0.6 },
  recipeImage: { width: '100%', aspectRatio: 16 / 9, borderRadius: 10, backgroundColor: '#f0f0f0', resizeMode: 'cover' },
  addImageButton: { justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: '#e0e0e0', borderStyle: 'dashed' },
  addImageButtonText: { marginTop: 8, color: primary, fontWeight: '600' },
  imageEditIcon: { position: 'absolute', bottom: 10, right: 10, backgroundColor: 'rgba(0,0,0,0.5)', padding: 8, borderRadius: 16 },
  selectionButton: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 24,
    margin: 16,
    marginTop: 0,
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 5,
    elevation: 3,
  },
  // The camera can take a second to come up, and a button that looks untouched
  // in that second reads as a button that didn't work.
  selectionButtonBusy: { opacity: 0.5 },
  selectionButtonTitle: { fontSize: 20, fontWeight: 'bold', color: primary, marginTop: 12, marginBottom: 6 },
  selectionButtonDescription: { fontSize: 14, color: '#666', textAlign: 'center' },
  iconRow: { flexDirection: 'row', gap: 16 },
  // ✅ 5. New styles for the loading screen
  loadingContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    minHeight: 250,
  },
  loadingText: {
    marginTop: 20,
    fontSize: 18,
    color: '#666',
    fontWeight: '600',
    textAlign: 'center',
  },
});