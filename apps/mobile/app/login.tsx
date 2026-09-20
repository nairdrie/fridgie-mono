import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';

// --- Native Sign-In Libraries ---
import * as AppleAuthentication from 'expo-apple-authentication';

// --- Firebase JS SDK Imports ---
import {
  AuthCredential,
  EmailAuthProvider,
  fetchSignInMethodsForEmail,
  linkWithCredential,
  signInWithCredential,
  signInWithEmailAndPassword
} from 'firebase/auth';

// --- Your Project's Imports ---
import { useKeyboardAwareScroll } from '@/hooks/useKeyboardAwareScroll';
import { auth } from '@/utils/firebase';
import {
  SocialAuthError,
  signInWithApple,
  signInWithFacebook,
  signInWithGoogle,
} from '@/utils/socialAuth';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { AmbientBackground, GlassPressable as TouchableOpacity, GlassSurface, useGlassPreferences } from '@/components/ui/Glass';
import Animated, { FadeInDown, FadeInUp, ReduceMotion } from 'react-native-reanimated';


type LoadingState = "google" | "apple" | "facebook" | "existing" | "email" | "password" | "";
// --- Added 'createPassword' to handle new user sign-up flow ---
type UIState = "initial" | "enterPassword" | "createPassword";



// Maps a Firebase provider id to the name and button copy the user actually sees.
const PROVIDER_NAMES: Record<string, string> = {
  'google.com': 'Google',
  'apple.com': 'Apple',
  'facebook.com': 'Facebook',
};

const providerLabel = (providerId: string) => {
  if (PROVIDER_NAMES[providerId]) return PROVIDER_NAMES[providerId];
  const name = providerId.split('.')[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
};

const providerButtonLabel = (providerId: string) => `Continue with ${providerLabel(providerId)}`;


export default function LoginScreen() {
    const { reduceMotion } = useGlassPreferences();
  const router = useRouter();
  const keyboard = useKeyboardAwareScroll();

  // --- State Management ---
  const [loading, setLoading] = useState<LoadingState>("");
  const [error, setError] = useState<string | null>(null);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [uiState, setUiState] = useState<UIState>("initial");
  const [confirmPassword, setConfirmPassword] = useState(""); // Added for create password flow

  const [pendingCredential, setPendingCredential] = useState<AuthCredential | null>(null);

  // --- New component for password validation feedback ---
  const PasswordStrengthIndicator = ({ password }: { password: string }) => {
    const checks = {
      length: password.length >= 8,
      uppercase: /[A-Z]/.test(password),
      lowercase: /[a-z]/.test(password),
      number: /[0-9]/.test(password),
    };

    const CheckItem = ({ label, passed }: { label: string, passed: boolean }) => (
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
        <Text style={{ color: passed ? '#23785E' : '#78857D', marginRight: 8, fontSize: 16 }}>{passed ? '✓' : '○'}</Text>
        <Text style={{ color: passed ? '#23785E' : '#78857D' }}>{label}</Text>
      </View>
    );

    return (
      <View style={styles.passwordChecksContainer}>
        <CheckItem label="At least 8 characters" passed={checks.length} />
        <CheckItem label="An uppercase letter" passed={checks.uppercase} />
        <CheckItem label="A lowercase letter" passed={checks.lowercase} />
        <CheckItem label="A number" passed={checks.number} />
      </View>
    );
  };


  // Runs a native provider sheet and feeds whatever it returns into Firebase.
  // A null credential means the user dismissed the sheet, which is not an error.
  const runSocialSignIn = async (
    provider: LoadingState,
    getCredential: () => Promise<AuthCredential | null>
  ) => {
    setLoading(provider);
    setError(null);
    try {
      const credential = await getCredential();
      if (!credential) {
        setLoading('');
        return;
      }
      await linkOrSignIn(credential);
    } catch (err: any) {
      console.error(`${provider} Sign-In Error:`, err);
      setError(
        err instanceof SocialAuthError
          ? err.message
          : 'Sign-in failed. Please try again.'
      );
      setLoading('');
    }
  };

  const handleGoogleSignIn = () => runSocialSignIn('google', signInWithGoogle);
  const handleFacebookSignIn = () => runSocialSignIn('facebook', signInWithFacebook);
  const handleAppleSignIn = () => runSocialSignIn('apple', signInWithApple);

  // --- Core Authentication Logic ---
  const linkOrSignIn = async (credential: AuthCredential) => {
    try {
      const anonymousUser = auth.currentUser;
      if (anonymousUser && anonymousUser.isAnonymous) {
        const userCredential = await linkWithCredential(anonymousUser, credential);
        if (!userCredential.user.displayName) {
          router.replace('/complete-profile');
        } else {
          router.replace('/profile');
        }
      } else {
        await signInWithCredential(auth, credential);
      }
    } catch (err: any) {
      if (err.code === 'auth/credential-already-in-use') {
        setPendingCredential(credential);
        setShowConflictModal(true);
      } else if (err.code === 'auth/operation-not-allowed') {
        // The provider is off in the Firebase console, or the build's bundle id
        // isn't an audience it accepts. Nothing the user can do about either, so
        // don't send them round the loop retrying. See docs/auth-provider-setup.md.
        console.error("Provider not configured in Firebase:", err);
        setError("This sign-in method isn't available right now. Please try another way to sign in.");
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
    // Set when we hand off to a social prompt, which owns the loading state from there.
    let handedOff = false;
    try {
      const methods = await fetchSignInMethodsForEmail(auth, email);

      if (methods.length > 0) {
        // If 'password' is a valid sign-in method for this email...
        if (methods.includes('password')) {
          setUiState("enterPassword");
        } else if (Platform.OS === 'web') {
          setError(`This account uses ${providerLabel(methods[0])}. Open the Fridgie app to continue with that sign-in method.`);
        } else if (methods.includes('google.com')) {
          // Google-linked account: skip the dead end and open the Google sheet for them.
          handedOff = true;
          handleGoogleSignIn();
        } else {
          // ...otherwise, the email is linked to another provider we can't auto-launch.
          const providerId = methods[0];
          setError(`This email is linked to a ${providerLabel(providerId)} account. Tap "${providerButtonLabel(providerId)}" below to sign in.`);
        }
      } else {
        // This is a new user, so let them create a password.
        setUiState("createPassword");
      }
    } catch (err: any) {
      console.error("Email check failed:", err);
      setError("Could not verify email. Please try again.");
    } finally {
      if (!handedOff) setLoading("");
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
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
       if (!userCredential.user.displayName) {
          router.replace('/complete-profile');
        } else {
          router.replace('/profile');
        }
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

  // --- New function to handle new account creation ---
  const handleCreateAccount = async () => {
    // --- All your validation logic remains the same ---
    if (!password || !confirmPassword) {
      setError("Please fill out both password fields.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    // You can add your password strength checks here too

    setLoading("password");
    setError(null);
    try {
      // 1. Get the current anonymous user
      const anonymousUser = auth.currentUser;
      if (anonymousUser && anonymousUser.isAnonymous) {
        // 2. Create an email/password credential from the user's input
        const credential = EmailAuthProvider.credential(email, password);

        // 3. Link the credential to the anonymous account, upgrading it
        const userCredential = await linkWithCredential(anonymousUser, credential);

        if (!userCredential.user.displayName) {
          router.replace('/complete-profile');
        } else {
          router.replace('/profile');
        }
      } else {
        // This is a fallback case in case there is no anonymous user.
        throw new Error("No anonymous user session found to link.");
      }
    } catch (err: any) {
      // The error handling is mostly the same
      if (err.code === 'auth/email-already-in-use') {
        setError("This email address is already in use by another account.");
      } else if (err.code === 'auth/weak-password') {
        setError("The password is too weak.");
      } else {
        setError("An error occurred. Please try again.");
        console.error("Account Linking Error:", err);
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
      const userCredential = await signInWithCredential(auth, pendingCredential);
      if (!userCredential.user.displayName) {
        router.replace('/complete-profile');
      } else {
        router.replace('/profile');
      }
    } catch (err: any) {
      console.error("Sign-in to existing account failed:", err);
      setError('Failed to sign in. Please try again.');
    } finally {
      setPendingCredential(null);
      setLoading('');
    }
  };

  return (
    <AmbientBackground>
    <SafeAreaView style={{ flex: 1 }}>
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0} // tweak this
    >
      <ScrollView
        ref={keyboard.scrollRef}
        {...keyboard.scrollProps}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: keyboard.keyboardSpace }}
        keyboardShouldPersistTaps="handled"
      >
        <StatusBar style="dark" />
        <View
          style={styles.outerContainer}
        >
          <View style={styles.loginNavigation}><GlassSurface style={styles.navigationGlass}><TouchableOpacity style={styles.navigationButton} onPress={() => router.back()} accessibilityLabel="Go back"><Ionicons name="chevron-back" size={21} color="#173F35" /></TouchableOpacity></GlassSurface></View>
          <Animated.View entering={FadeInDown.duration(650).reduceMotion(ReduceMotion.System)} style={styles.logoContainer}>
            <View style={styles.brandRow}>
              <View style={styles.brandMark}><Ionicons name="leaf" size={24} color={primary} /></View>
              <Text style={styles.brandName}>fridgie</Text>
            </View>
            <Text style={styles.heroTitle}>Life tastes better{ '\n' }together.</Text>
            <Text style={styles.heroSubtitle}>Your recipes, your people, your everyday.</Text>
            <View style={styles.heroChips}>
              <GlassSurface style={styles.heroChip}><Ionicons name="basket-outline" size={15} color={primary} /><Text style={styles.heroChipText}>Shop simply</Text></GlassSurface>
              <GlassSurface style={styles.heroChip}><Ionicons name="restaurant-outline" size={15} color={primary} /><Text style={styles.heroChipText}>Eat well</Text></GlassSurface>
            </View>
          </Animated.View>
          <Animated.View entering={FadeInUp.delay(120).duration(600).reduceMotion(ReduceMotion.System)} style={styles.cardWrapper}>
          <GlassSurface style={styles.loginCard} intensity={60}>
            <View style={styles.loginCardUpper}>
              {uiState !== 'initial' && (
                <TouchableOpacity onPress={() => {
                  setUiState('initial');
                  setError(null);
                  setPassword('');
                  setConfirmPassword('');
                }} style={styles.backButton}>
                  <Ionicons name="arrow-back" size={24} color="#333" />
                </TouchableOpacity>
              )}
              <Text style={styles.heading}>
                {uiState === 'createPassword'
                  ? 'Make yourself at home'
                  : uiState === 'enterPassword'
                    ? 'Welcome back'
                    : 'Make room for good food'}
              </Text>
            </View>

            {uiState === 'initial' ? (
              <TextInput
                style={styles.inputField}
                placeholder="Your email address"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                placeholderTextColor={'#797979ff'}
              />
            ) : (
              <Text style={styles.emailDisplay}>{email}</Text>
            )}

            {uiState === 'initial' && (
              <TouchableOpacity
                style={[styles.primaryButton, (loading === 'email') && styles.disabledButton]}
                onPress={handleEmailContinue}
                disabled={loading === 'email'}
              >
                {loading === 'email' ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Continue with email</Text>}
              </TouchableOpacity>
            )}

            {uiState === 'enterPassword' && (
              <>
                <TextInput
                  style={styles.inputField}
                  placeholder="Password"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoComplete="password"
                  placeholderTextColor={'#797979ff'}
                />
                <TouchableOpacity
                  style={[styles.primaryButton, (loading === 'password') && styles.disabledButton]}
                  onPress={handlePasswordSignIn}
                  disabled={loading === 'password'}
                >
                  {loading === 'password' ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Sign In</Text>}
                </TouchableOpacity>
              </>
            )}

            {uiState === 'createPassword' && (
              <>
                <TextInput
                  style={styles.inputField}
                  placeholder="Create a password"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  placeholderTextColor={'#797979ff'}
                />
                <PasswordStrengthIndicator password={password} />
                <TextInput
                  style={styles.inputField}
                  placeholder="Confirm password"
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  secureTextEntry
                  placeholderTextColor={'#797979ff'}
                />
                <TouchableOpacity
                  style={[styles.primaryButton, (loading === 'password') && styles.disabledButton]}
                  onPress={handleCreateAccount}
                  disabled={loading === 'password'}
                >
                  {loading === 'password' ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Create your account</Text>}
                </TouchableOpacity>
              </>
            )}

            {uiState === 'initial' && Platform.OS !== 'web' && (
              <>
                <View style={styles.separatorContainer}>
                  <View style={styles.separatorLine} />
                  <Text style={styles.separatorText}>or</Text>
                  <View style={styles.separatorLine} />
                </View>
                <TouchableOpacity
                  style={[styles.googleButton, (loading !== '' && loading !== 'google') && styles.disabledButton]}
                  onPress={handleGoogleSignIn}
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
                {Platform.OS === 'ios' && (
                  <AppleAuthentication.AppleAuthenticationButton
                    buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                    buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE_OUTLINE}
                    cornerRadius={19}
                    style={[styles.appleButton, (loading !== '' && loading !== 'apple') && styles.disabledButton]}
                    onPress={handleAppleSignIn}
                  />
                )}
                <TouchableOpacity
                  style={[styles.facebookButton, (loading !== '' && loading !== 'facebook') && styles.disabledButton]}
                  onPress={handleFacebookSignIn}
                  disabled={loading !== ''}
                >
                  {loading === 'facebook' ? (
                    <ActivityIndicator color={primary} />
                  ) : (
                    <>
                      <Image source={require('../assets/f-logo.png')} style={{ width: 24, height: 24, marginRight: 10 }} />
                      <Text style={styles.facebookButtonText}>Continue with Facebook</Text>
                    </>
                  )}
                </TouchableOpacity>
              </>
            )}

            {error && <Text style={styles.error}>{error}</Text>}
            <Text style={styles.footerNote}>A little more organized. A lot more delicious.</Text>
          </GlassSurface>
          </Animated.View>
        </View>


        <Modal visible={showConflictModal} transparent={true} animationType={reduceMotion ? "none" : "fade"}>
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
      </ScrollView>
    </KeyboardAvoidingView>
    </SafeAreaView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  outerContainer: { flex: 1, alignItems: 'center', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 32 },
  loginNavigation: { position: 'absolute', top: 22, left: 20, zIndex: 2 },
  navigationGlass: { borderRadius: 20 },
  navigationButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  logoContainer: { alignItems: 'center', width: '100%', paddingVertical: 24 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 24 },
  brandMark: { width: 40, height: 40, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(220,237,226,0.9)', borderWidth: 1, borderColor: '#FFFFFF' },
  brandName: { fontSize: 28, letterSpacing: -1.4, fontWeight: '800', color: '#173F35' },
  heroTitle: { fontSize: 39, lineHeight: 43, letterSpacing: -1.8, fontWeight: '700', color: '#173F35', textAlign: 'center' },
  heroSubtitle: { marginTop: 12, fontSize: 14, color: '#78857D', textAlign: 'center', lineHeight: 21 },
  heroChips: { flexDirection: 'row', gap: 8, marginTop: 20 },
  heroChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 9, paddingHorizontal: 13, borderRadius: 20 },
  heroChipText: { color: '#476458', fontSize: 12, fontWeight: '600' },
  cardWrapper: { width: '100%', maxWidth: 460 },
  loginCard: { borderRadius: 30, padding: 24, width: '100%' },
  loginCardUpper: { flexDirection: 'row', alignItems: 'center', marginBottom: 24, minHeight: 32 },
  heading: { fontSize: 21, fontWeight: '700', letterSpacing: -0.6, textAlign: 'center', flex: 1, color: '#173F35' },
  primaryButton: { backgroundColor: primary, borderRadius: 19, alignItems: 'center', marginBottom: 14, justifyContent: 'center', minHeight: 54, paddingVertical: 14, paddingHorizontal: 14, shadowColor: '#173F35', shadowOffset: { width: 0, height: 6 }, shadowRadius: 12, shadowOpacity: 0.1 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  appleButton: { height: 52, marginBottom: 12 },
  disabledButton: { opacity: 0.5 },
  error: { color: '#AE5341', fontSize: 14, textAlign: 'center', marginTop: 12, lineHeight: 20 },
  footerNote: { fontSize: 11, color: '#78857D', textAlign: 'center', marginTop: 6, lineHeight: 17 },
  modalContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(23,63,53,0.24)' },
  modalContent: { backgroundColor: '#F5F5EF', padding: 26, borderRadius: 30, width: '88%', maxWidth: 360, alignItems: 'center', shadowColor: '#173F35', shadowOpacity: 0.15, shadowRadius: 30, elevation: 10 },
  modalTitle: { fontSize: 23, fontWeight: '700', letterSpacing: -0.6, marginBottom: 12, textAlign: 'center', color: '#173F35' },
  modalMessage: { textAlign: 'center', marginBottom: 24, fontSize: 15, lineHeight: 23, color: '#78857D' },
  modalButtons: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', gap: 12 },
  modalButton: { flex: 1, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 18, alignItems: 'center', backgroundColor: '#E6EBE4' },
  modalConfirmButton: { backgroundColor: primary },
  modalConfirmButtonText: { color: 'white', fontWeight: '700' },
  googleButton: { backgroundColor: 'rgba(255,255,255,0.76)', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 52, borderRadius: 19, paddingHorizontal: 10, marginBottom: 12, borderWidth: 1, borderColor: '#E4E9E0' },
  googleButtonText: { color: '#173F35', fontSize: 15, fontWeight: '600' },
  inputField: { height: 54, borderWidth: 1, borderColor: '#E2E8DE', borderRadius: 18, paddingHorizontal: 17, marginBottom: 14, fontSize: 16, color: '#173F35', backgroundColor: 'rgba(255,255,255,0.65)' },
  separatorContainer: { flexDirection: 'row', alignItems: 'center', marginTop: 2, marginBottom: 18 },
  separatorLine: { flex: 1, height: 1, backgroundColor: '#E3E8DF' },
  separatorText: { marginHorizontal: 14, color: '#99A399', fontSize: 12 },
  facebookButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 52, borderRadius: 19, paddingHorizontal: 10, marginBottom: 12, borderWidth: 1, borderColor: '#E4E9E0', backgroundColor: 'rgba(255,255,255,0.76)' },
  facebookButtonText: { color: '#173F35', fontSize: 15, fontWeight: '600' },
  backButton: { marginRight: 12, width: 32, height: 36, alignItems: 'center', justifyContent: 'center' },
  emailDisplay: { fontSize: 15, fontWeight: '500', backgroundColor: '#EAF0E7', paddingHorizontal: 16, paddingVertical: 14, borderRadius: 18, marginBottom: 20, textAlign: 'center', color: '#476458' },
  passwordChecksContainer: { marginTop: 2, marginBottom: 16, paddingLeft: 10, alignSelf: 'flex-start' },
});
