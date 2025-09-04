import {
  ActivityIndicator,
  Image,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';

// --- Native Sign-In Libraries ---
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Facebook from 'expo-auth-session/providers/facebook';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';

// --- Firebase JS SDK Imports ---
import {
  AuthCredential,
  FacebookAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  fetchSignInMethodsForEmail,
  linkWithCredential,
  signInWithCredential,
  signInWithEmailAndPassword
} from 'firebase/auth';

// --- Your Project's Imports ---
import { auth } from '@/utils/firebase';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { KeyboardAwareScrollView } from "react-native-keyboard-aware-scroll-view";
import Logo from '../components/Logo';


// This is needed for expo-auth-session to work correctly on web
WebBrowser.maybeCompleteAuthSession();

// Get your client IDs from a secure place or define them here
const IOS_CLIENT_ID = "598650352064-t8n659ud33kd09jfagcas0akr8j0r3kj.apps.googleusercontent.com";
const ANDROID_CLIENT_ID = "598650352064-tdjm4ia5oemhgl0ml6hh020d4et251o5.apps.googleusercontent.com";
const EXPO_CLIENT_ID = "598650352064-bjkgnsj14of6fs4f9ggkmi9tlqptuiat.apps.googleusercontent.com";
const FACEBOOK_APP_ID = "776186408706339";

type LoadingState = "google" | "apple" | "facebook" | "existing" | "email" | "password" | "";
type UIState = "initial" | "enterPassword";

export default function LoginScreen() {
  const router = useRouter();

  // --- State Management ---
  const [loading, setLoading] = useState<LoadingState>("");
  const [error, setError] = useState<string | null>(null);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [uiState, setUiState] = useState<UIState>("initial");
  
  // State to hold the credential while the user decides whether to link or sign in
  const [pendingCredential, setPendingCredential] = useState<AuthCredential | null>(null);

  // --- Google Sign-In Hook ---
  const [request, response, promptAsync] = Google.useAuthRequest({
    iosClientId: IOS_CLIENT_ID,
    androidClientId: ANDROID_CLIENT_ID,
    webClientId: EXPO_CLIENT_ID
  });

   const [facebookRequest, facebookResponse, promptFacebookAsync] = Facebook.useAuthRequest({
    clientId: FACEBOOK_APP_ID,
  });

  // Effect to handle the response from Google's native prompt
  useEffect(() => {
    const handleGoogleResponse = async () => {
        if (response?.type === 'success') {
            const { id_token } = response.params;
            const credential = GoogleAuthProvider.credential(id_token);
            await linkOrSignIn(credential);
        } else if (response?.type === 'error' || response?.type === 'cancel' || response?.type === 'dismiss') {
            setError(response.type === 'error' ? 'Google Sign-In failed. Please try again.' : null);
            setLoading('');
        }
    };
    handleGoogleResponse();
  }, [response]);

  // Effect to handle the response from Facebook's native prompt - Added
  useEffect(() => {
    const handleFacebookResponse = async () => {
      if (facebookResponse?.type === 'success') {
          const { access_token } = facebookResponse.params;
          const credential = FacebookAuthProvider.credential(access_token);
          await linkOrSignIn(credential);
      } else if (facebookResponse?.type === 'error' || facebookResponse?.type === 'cancel' || facebookResponse?.type === 'dismiss') {
          setError(facebookResponse.type === 'error' ? 'Facebook Sign-In failed. Please try again.' : null);
          setLoading('');
      }
    };
    handleFacebookResponse();
  }, [facebookResponse]);

  // --- Core Authentication Logic ---
  const linkOrSignIn = async (credential: AuthCredential) => {
    try {
      const anonymousUser = auth.currentUser;
      if (anonymousUser && anonymousUser.isAnonymous) {
        // If there's an anonymous user, try to link the new credential
        const userCredential = await linkWithCredential(anonymousUser, credential);
        // On successful link, onAuthStateChanged should handle navigation
        // or you can navigate here explicitly.
        if(!userCredential.user.displayName) {
          router.replace('/complete-profile');
        } else {
          router.replace('/list'); // Navigate to home screen
        }
      } else {
        // If no user or a non-anonymous user, just sign in
        await signInWithCredential(auth, credential);
        // After sign-in, onAuthStateChanged will trigger a redirect
      }
    } catch (err: any) {
      if (err.code === 'auth/credential-already-in-use') {
        // If the credential is in use, store it and show the conflict modal
        setPendingCredential(credential);
        setShowConflictModal(true);
      } else {
        console.error("Authentication Error:", err);
        setError(err.message || 'An error occurred during sign-in.');
      }
    } finally {
      setLoading('');
    }
  };

const handleEmailContinue = async () => {
  if (!email) {
   setError("Please enter your email address.");
   return;
  }
  setLoading("email");
  setError(null);
  try {
   const methods = await fetchSignInMethodsForEmail(auth, email);
   if (methods.length > 0) {
    if (methods.includes('password')) {
     // User has an email/password account, ask for password
     setUiState("enterPassword");
    } else {
     // User signed up with a social provider (e.g., Google)
     setError(`This email is linked to a ${methods[0]} account. Please use that method to sign in.`);
    }
   } else {
    // New user, route to create account/password screen
    // router.push({'/create-account', params: { email } });
   }
  } catch (err: any) {
   console.error("Email check failed:", err);
   setError("Could not verify email. Please try again.");
  } finally {
   setLoading("");
  }
 };

 const handlePasswordSignIn = async () => {
  if (!password) {
   setError("Please enter your password.");
   return;
  }
  setLoading("password");
  setError(null);
  try {
   await signInWithEmailAndPassword(auth, email, password);
   // onAuthStateChanged will handle the redirect
  } catch (err: any) {
   if (err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
    setError("Invalid email or password.");
   } else {
    setError("An error occurred. Please try again.");
   }
  } finally {
setLoading("");
}
};

  const handleSignInToExistingAccount = async () => {
    if (!pendingCredential) return;
    setLoading('existing');
    setShowConflictModal(false);
    try {
      // Sign in with the stored credential, which overwrites the anonymous user
      await signInWithCredential(auth, pendingCredential);
    } catch (err: any) {
      console.error("Sign-in to existing account failed:", err);
      setError('Failed to sign in. Please try again.');
    } finally {
      setPendingCredential(null);
      setLoading('');
    }
  };
  
  // --- Apple Sign-In Handler ---
  const handleAppleSignIn = async () => {
    setLoading('apple');
    setError(null);
    try {
      const appleCredential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (appleCredential.identityToken) {
        const provider = new OAuthProvider('apple.com');
        const credential = provider.credential({
          idToken: appleCredential.identityToken,
        });
        await linkOrSignIn(credential);
      } else {
        throw new Error('Could not get Apple identity token.');
      }
    } catch (e: any) {
      if (e.code !== 'ERR_REQUEST_CANCELED') {
        console.error("Apple Sign-In Error:", e);
        setError('Apple Sign-In failed. Please try again.');
      }
    } finally {
      setLoading('');
    }
  };
  
  return (
    
    <KeyboardAwareScrollView
      contentContainerStyle={styles.outerContainer}
      keyboardShouldPersistTaps="handled"
    >
      <StatusBar style="light" />
      <Modal visible={showConflictModal} transparent={true} animationType="fade">
        <View style={styles.modalContainer}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Account Exists</Text>
            <Text style={styles.modalMessage}>
              This social account is already linked to another user. Would you like to sign in to that account instead?
              Your current guest session will be discarded.
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalButton} onPress={() => {
                  setShowConflictModal(false);
                  setPendingCredential(null);
              }}>
                  <Text>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalButton, styles.modalConfirmButton]} onPress={handleSignInToExistingAccount}>
                  <Text style={styles.modalConfirmButtonText}>Sign In</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Logo variant="new" style={{ alignSelf: 'center', marginTop: 150, marginBottom: 50 }} />
      <View style={styles.loginCard}>
        <Text style={styles.heading}>Login or create an account</Text>
        <TextInput
          style={styles.inputField}
          placeholder="Enter your email address..."
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          placeholderTextColor={'#797979ff'}
        />
      <TouchableOpacity
        style={[styles.primaryButton, (loading === 'email') && styles.disabledButton]}
        onPress={handleEmailContinue}
        disabled={loading === 'email'}
      >
        {loading === 'email' ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Continue with Email</Text>}
      </TouchableOpacity>

   <View style={styles.separatorContainer}>
    <View style={styles.separatorLine} />
    <Text style={styles.separatorText}>or</Text>
    <View style={styles.separatorLine} />
   </View>
        <TouchableOpacity
          style={[styles.googleButton, (loading !== '' && loading !== 'google') && styles.disabledButton]}
          onPress={() => {
            setLoading('google');
            setError(null);
            promptAsync();
          }}
          disabled={loading !== ''}
        >
          {loading === 'google' ? (
            <ActivityIndicator color="#1F1F1F" />
          ) : (
            <>
              <Image source={require('../assets/g-logo.png')} style={{ width: 24, height: 24, marginRight: 8 }} />
              <Text style={styles.googleButtonText}>Continue with Google</Text>
            </>
          )}
        </TouchableOpacity>


        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={8}
          style={[styles.appleButton, (loading !== '' && loading !== 'apple') && styles.disabledButton]}
          onPress={handleAppleSignIn}
        />

        <TouchableOpacity
          style={[styles.facebookButton, (loading !== '' && loading !== 'facebook') && styles.disabledButton]}
          onPress={() => {
            setLoading('facebook');
            setError(null);
            promptFacebookAsync();
          }}
          disabled={loading !== ''}
        >
          {loading === 'facebook' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              {/* Make sure you have a facebook logo in your assets folder */}
              <Image source={require('../assets/f-logo.png')} style={{ width: 24, height: 24, marginRight: 10 }} />
              <Text style={styles.facebookButtonText}>Continue with Facebook</Text>
            </>
          )}
        </TouchableOpacity>


        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    </KeyboardAwareScrollView>
  );
}

// Your existing styles plus the modal styles
const styles = StyleSheet.create({
  outerContainer: { 
    flexGrow: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: '#0b2215'
  },
  loginCard: { 
    backgroundColor: 'white', borderRadius: 12, padding: 24, width: '100%', maxWidth: 400, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 10, elevation: 5, flexGrow: 1
  },
  heading: { fontSize: 24, fontWeight: '600', textAlign: 'center', marginBottom: 24 },
  primaryButton: { backgroundColor: '#106b23ff', paddingVertical: 14, borderRadius: 32, alignItems: 'center', marginBottom: 16, justifyContent: 'center', height: 50 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  appleButton: { height: 50, marginBottom: 16 },
  disabledButton: { opacity: 0.6 },
  error: { color: 'red', textAlign: 'center', marginTop: 12 },
  modalContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.5)' },
  modalContent: { backgroundColor: 'white', padding: 20, borderRadius: 10, width: '85%', maxWidth: 320, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 10, elevation: 10 },
  modalTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 10, textAlign: 'center' },
  modalMessage: { textAlign: 'center', marginBottom: 20, fontSize: 16, lineHeight: 22 },
  modalButtons: { flexDirection: 'row', justifyContent: 'space-between', width: '100%' },
  modalButton: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8, minWidth: 100, alignItems: 'center' },
  modalConfirmButton: { backgroundColor: '#4285F4' },
  modalConfirmButtonText: { color: 'white', fontWeight: 'bold' },
  logo: { padding: 20 },
  logoText: { fontSize: 32, fontWeight: 'bold' },
  googleButton: {
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 50,
    borderRadius: 32,
    paddingHorizontal: 10,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.22,
    shadowRadius: 2.22,
    elevation: 0,
    marginBottom: 16,
    borderWidth:1,
    borderColor: '#bbb'
  },
  googleButtonText: {
    color: '#1F1F1F', // Standard Google text color
    fontSize: 16,
    fontWeight: '600', // Google uses a medium weight, 600 is a good approximation
  },
   inputField: {
    height: 50,
    borderWidth: 1,
    borderColor: '#333333',
    borderRadius: 32,
    paddingHorizontal: 16,
    marginBottom: 16,
    fontSize: 16,
  },
  separatorContainer: { flexDirection: 'row', alignItems: 'center', marginTop: 8, marginBottom: 24 },
  separatorLine: { flex: 1, height: 1, backgroundColor: '#ddd' },
  separatorText: { marginHorizontal: 12, color: '#888' },
  facebookButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 50,
    borderRadius: 32,
    paddingHorizontal: 10,
    marginBottom: 16,
    borderWidth:1,
    borderColor: '#bbb'
  },
  facebookButtonText: {
    color: '#1F1F1F',
    fontSize: 16,
    fontWeight: '600',
  },
});