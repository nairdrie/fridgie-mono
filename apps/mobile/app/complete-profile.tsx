import { AmbientBackground, GlassPressable as TouchableOpacity, GlassSurface } from '@/components/ui/Glass';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';
import { useAuth } from '@/context/AuthContext';
import { useKeyboardAwareScroll } from '@/hooks/useKeyboardAwareScroll';
import { defaultAvatars } from '@/utils/defaultAvatars';
import { auth, storage } from '@/utils/firebase';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { updateProfile } from 'firebase/auth';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';


async function updateUserProfile(data: { name: string; photoURL: string }) {
  const { name, photoURL } = data;
  const user = auth.currentUser;

  if (!user) throw new Error('No user is signed in.');

  let finalPhotoURL = photoURL;

  // 1. Check if the photo is a local file from the image picker
  if (photoURL.startsWith('file://')) {
    try {
      // 2. Convert the local file URI to a blob
      const response = await fetch(photoURL);
      const blob = await response.blob();

      // 3. Create a reference in Firebase Storage (e.g., /profile_images/USER_ID)
      const storageRef = ref(storage, `profile_images/${user.uid}`);

      // 4. Upload the blob to Firebase Storage
      await uploadBytes(storageRef, blob);

      // 5. Get the public URL of the uploaded image
      finalPhotoURL = await getDownloadURL(storageRef);
    } catch (error) {
      console.error('Error uploading image: ', error);
      throw new Error('Failed to upload profile picture.');
    }
  }

  // 6. Update the user's profile in Firebase Authentication
  await updateProfile(user, {
    displayName: name,
    photoURL: finalPhotoURL,
  });

  // 7. (Optional) You can now send this final, public URL to your own backend
  //    database if you need to store it there as well.
}

export default function CompleteProfileScreen() {
  const router = useRouter();
  const { user, refreshAuthUser } = useAuth();
  // Wider than the default: the Continue button sits directly under the name
  // field, and lifting the field alone would leave the button behind the keyboard.
  const keyboard = useKeyboardAwareScroll({ gap: 60 });
  

  const [name, setName] = useState('');
  const [selectedPhotoUrl, setSelectedPhotoUrl] = useState(user?.photoURL);
  const [loading, setLoading] = useState(false);

  const flatListRef = useRef<FlatList | null>(null);
  const [isAtStart, setIsAtStart] = useState(true);
  const [isAtEnd, setIsAtEnd] = useState(false);

  const carouselData = [...defaultAvatars, 'upload'];

  // No permission asked for: the system photo picker runs out of process and
  // hands back only the one image the user chose, so there is nothing to grant.
  // Asking anyway prompted for storage access on older Android for no reason,
  // and every extra permission request is one more that can go astray.
  const handlePickImage = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
    });

    if (!result.canceled) {
      setSelectedPhotoUrl(result.assets[0].uri);
    }
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    const scrollX = contentOffset.x;
    
    // Check if at the start
    setIsAtStart(scrollX < 10);
    
    // Check if at the end
    const isEnd = scrollX + layoutMeasurement.width >= contentSize.width - 10;
    setIsAtEnd(isEnd);
  };

  const scrollTo = (direction: 'left' | 'right') => {
    flatListRef.current?.scrollToIndex({
      index: direction === 'right' ? carouselData.length - 1 : 0,
      animated: true,
      viewPosition: 0.5, // Center the item
    });
  };

  const handleSaveProfile = async () => {
    if (!name.trim() || !selectedPhotoUrl) {
      Alert.alert('Please enter your name and select a photo.');
      return;
    }
    setLoading(true);
    try {
      await updateUserProfile({ name, photoURL: selectedPhotoUrl });
      
      // Update the user in Firebase Auth directly
      if (auth.currentUser) {
        await updateProfile(auth.currentUser, { displayName: name, photoURL: selectedPhotoUrl });
      }

      refreshAuthUser();

      // await refetchProfile(); // Refresh the profile in the context
      router.replace('/profile'); // Use replace to prevent going back
    } catch (error) {
      console.error('Failed to save profile:', error);
      Alert.alert('Error', 'Could not save your profile. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    // One scroller, not two. A plain ScrollView nested inside this one owned the
    // vertical gesture, so the scroll that puts the focused input above the
    // keyboard had nothing to scroll — the name field and Continue button, both
    // at the bottom of the form, stayed under it.
    <AmbientBackground>
    <ScrollView
          ref={keyboard.scrollRef}
          {...keyboard.scrollProps}
          style={styles.safeArea}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.container, { paddingBottom: Math.max(32, keyboard.keyboardSpace) }]}>
        <Animated.View entering={FadeInDown.duration(550).reduceMotion(ReduceMotion.System)} style={styles.content}>
        <View style={styles.welcomePill}><Ionicons name="sparkles-outline" size={14} color="#23785E" /><Text style={styles.welcomePillText}>A FRESH START</Text></View>
        <Text style={styles.title}>A little more you.</Text>
        <Text style={styles.subtitle}>Let’s make this kitchen yours.</Text>
        <View style={styles.avatarHalo}>
          {selectedPhotoUrl ? <Image source={{ uri: selectedPhotoUrl }} style={styles.mainAvatar} /> : <View style={[styles.mainAvatar, styles.avatarPlaceholder]}><Ionicons name="person-outline" size={52} color="#789787" /></View>}
          <TouchableOpacity style={styles.photoButton} onPress={handlePickImage} accessibilityLabel="Choose a profile photo"><Ionicons name="camera" size={18} color="#fff" /></TouchableOpacity>
        </View>
        <GlassSurface style={styles.formCard}>
        <Text style={styles.label}>Pick a little personality</Text>
        <View style={styles.carouselContainer}>

        <TouchableOpacity style={[styles.arrowButton, isAtStart && styles.transparentButton]} onPress={() => scrollTo('left')}>
            <Ionicons name="chevron-back" size={24} color="#666" />
        </TouchableOpacity>

          <FlatList
            ref={flatListRef}
            data={carouselData}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyExtractor={(item) => item}
            onScroll={handleScroll}
            scrollEventThrottle={16} // Improves onScroll performance
            contentContainerStyle={styles.flatListContent}
            renderItem={({ item }) => {
              if (item === 'upload') {
                return (
                  <TouchableOpacity style={styles.uploadButton} onPress={handlePickImage}>
                    <Ionicons name="camera-outline" size={24} color="#666" />
                  </TouchableOpacity>
                );
              }
              return (
                <TouchableOpacity onPress={() => setSelectedPhotoUrl(item)}>
                  <Image
                    source={{ uri: item }}
                    style={[
                      styles.gridAvatar,
                      selectedPhotoUrl === item && styles.selectedAvatar,
                    ]}
                  />
                </TouchableOpacity>
              );
            }}
          />

        <TouchableOpacity style={[styles.arrowButton, isAtEnd && styles.transparentButton]} onPress={() => scrollTo('right')}>
            <Ionicons name="chevron-forward" size={24} color="#666" />
        </TouchableOpacity>

        </View>

        <Text style={styles.label}>What should we call you?</Text>
        <TextInput
          style={styles.input}
          placeholder="Your name"
          value={name}
          onChangeText={setName}
          placeholderTextColor="#8B988E"
        />

        <TouchableOpacity
          style={[styles.primaryButton, (loading || !name) && styles.disabledButton]}
          onPress={handleSaveProfile}
          disabled={loading || !name}
        >
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Continue</Text>}
        </TouchableOpacity>
        </GlassSurface>
        <Text style={styles.footnote}>Good things start around the table.</Text>
        </Animated.View>
    </ScrollView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: 'transparent' },
    container: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24, paddingTop: 36 },
    content: { width: '100%', maxWidth: 460, alignItems: 'center' },
    welcomePill: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 13, paddingVertical: 9, backgroundColor: '#E4EDE0', borderRadius: 20, marginBottom: 19 },
    welcomePillText: { fontSize: 10, fontWeight: '700', color: '#476458', letterSpacing: 1.4 },
    title: { fontSize: 34, fontWeight: '700', letterSpacing: -1.4, color: '#173F35', marginBottom: 8, textAlign: 'center' },
    subtitle: { fontSize: 16, color: '#78857D', marginBottom: 28, textAlign: 'center' },
    avatarHalo: { padding: 10, backgroundColor: 'rgba(220,237,226,0.65)', borderRadius: 60, marginBottom: 28 },
    mainAvatar: { width: 116, height: 116, borderRadius: 48, backgroundColor: '#DCEDE2', borderColor: '#fff', borderWidth: 3 },
    avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
    photoButton: { position: 'absolute', bottom: 4, right: 4, width: 36, height: 36, borderRadius: 15, borderWidth: 2, borderColor: '#F5F5EF', backgroundColor: '#23785E', alignItems: 'center', justifyContent: 'center' },
    formCard: { padding: 22, borderRadius: 30, alignItems: 'center', width: '100%' },
    label: { fontSize: 13, fontWeight: '600', color: '#476458', alignSelf: 'flex-start', marginBottom: 12, marginTop: 10 },
    gridAvatar: { width: 52, height: 52, borderRadius: 20, margin: 5, backgroundColor: '#E4EDE0', borderColor: '#FFF', borderWidth: 2 },
    selectedAvatar: { borderWidth: 3, borderColor: '#23785E' },
    uploadButton: { width: 52, height: 52, borderRadius: 20, margin: 5, backgroundColor: '#E6EBE4', justifyContent: 'center', alignItems: 'center' },
    input: { width: '100%', borderWidth: 1, borderColor: '#E2E8DE', backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 18, padding: 17, fontSize: 16, color: '#173F35', marginBottom: 20 },
    primaryButton: { width: '100%', backgroundColor: '#23785E', paddingVertical: 17, borderRadius: 20, alignItems: 'center' },
    primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
    disabledButton: { opacity: 0.5 },
    carouselContainer: { flexDirection: 'row', alignItems: 'center', width: '100%', marginBottom: 20 },
    arrowButton: { paddingHorizontal: 3, minHeight: 44, justifyContent: 'center' },
    transparentButton: { opacity: 0 },
    flatListContent: { paddingHorizontal: 5 },
    footnote: { fontSize: 12, color: '#78857D', marginTop: 23 },
});
