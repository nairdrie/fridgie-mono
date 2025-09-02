import { useAuth } from '@/context/AuthContext';
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
  TouchableOpacity,
  View
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';


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
  

  const [name, setName] = useState('');
  const [selectedPhotoUrl, setSelectedPhotoUrl] = useState(user?.photoURL);
  const [loading, setLoading] = useState(false);

  const flatListRef = useRef<FlatList | null>(null);
  const [isAtStart, setIsAtStart] = useState(true);
  const [isAtEnd, setIsAtEnd] = useState(false);

  const carouselData = [...defaultAvatars, 'upload'];

  const handlePickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Sorry, we need camera roll permissions to make this work!');
      return;
    }

    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
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
      router.replace('/list'); // Use replace to prevent going back
    } catch (error) {
      console.error('Failed to save profile:', error);
      Alert.alert('Error', 'Could not save your profile. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAwareScrollView
          enableOnAndroid={true} // makes sure Android scrolls too
          extraScrollHeight={60} // bump focused input just above keyboard
          keyboardOpeningTime={0} // avoid flicker
          // behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          contentContainerStyle={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Welcome!</Text>
        <Text style={styles.subtitle}>Let's set up your profile.</Text>
        { selectedPhotoUrl &&
          <Image source={{ uri: selectedPhotoUrl }} style={styles.mainAvatar} />
        }
        

        <Text style={styles.label}>Choose an Avatar</Text>
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
          placeholder="Graham Cracker"
          value={name}
          onChangeText={setName}
          placeholderTextColor="#999"
        />

        <TouchableOpacity
          style={[styles.primaryButton, (loading || !name) && styles.disabledButton]}
          onPress={handleSaveProfile}
          disabled={loading || !name}
        >
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Continue</Text>}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: '#fff' },
    container: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
    title: { fontSize: 32, fontWeight: 'bold', marginBottom: 8 },
    subtitle: { fontSize: 18, color: '#666', marginBottom: 32 },
    mainAvatar: { width: 120, height: 120, borderRadius: 60, marginBottom: 16, backgroundColor: '#eee',  borderColor:'#e9e9e9ff', borderWidth:1},
    label: { fontSize: 16, fontWeight: '500', alignSelf: 'flex-start', marginBottom: 12, marginTop: 24 },
    avatarGrid: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 },
    gridAvatar: { width: 50, height: 50, borderRadius: 25, margin: 5, backgroundColor: '#eee', borderColor:'#e9e9e9ff', borderWidth:1 },
    selectedAvatar: { borderWidth: 3, borderColor: '#00715a' },
    uploadButton: { width: 50, height: 50, borderRadius: 25, margin: 5, backgroundColor: '#f0f0f0', justifyContent: 'center', alignItems: 'center' },
    uploadText: { fontSize: 24, color: '#999' },
    input: { width: '100%', borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 14, fontSize: 16, marginBottom: 32 },
    primaryButton: { width: '100%', backgroundColor: '#00715a', paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
    primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
    disabledButton: { backgroundColor: '#a9a9a9' },
    carouselContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        width: '100%', // Take up full width to position arrows
    },
    arrowButton: {
        paddingHorizontal: 4,
    },
    transparentButton: {
        opacity: 0
    },
    flatListContent: {
        paddingHorizontal: 10, // Give some space at the start and end of the list
    },
});