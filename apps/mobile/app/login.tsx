import React, { useRef, useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';

// --- Core Firebase and Expo Recaptcha Imports ---
// This is the required package to bridge Firebase Auth with Expo's environment
import { FirebaseRecaptchaVerifierModal } from 'expo-firebase-recaptcha';
// These are the functions from the Firebase JS SDK you installed
import {
    ConfirmationResult,
    getAuth,
    signInWithPhoneNumber,
} from 'firebase/auth';

// --- Your Project's Imports ---
// IMPORTANT: Make sure you have a firebaseConfig.js file that exports your config
import { firebaseConfig } from '@/utils/firebase';
import { useRouter } from 'expo-router';
import Logo from '../components/Logo';
import { loginWithToken } from '../utils/api';
import { toE164 } from '../utils/utils';



export default function LoginScreen() {
    const router = useRouter();

  // Ref for the reCAPTCHA modal
  const recaptchaVerifier = useRef<FirebaseRecaptchaVerifierModal>(null);

  const auth = getAuth();

  // --- State Management ---
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // This state will hold the confirmation object returned by Firebase
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);

  /**
   * Sends a verification code to the user's phone number.
   */
  const sendCode = async () => {
    setLoading(true);
    setError(null);
    try {
      const e164PhoneNumber = toE164(phone);
      if (!recaptchaVerifier.current) {
        throw new Error("Recaptcha Verifier is not available.");
      }
      // The recaptchaVerifier.current provides the necessary proof of humanity
      const confirmation = await signInWithPhoneNumber(auth, e164PhoneNumber, recaptchaVerifier.current);
      
      // Save the confirmation object to state to use in the next step
      setConfirmationResult(confirmation);

    } catch (err: any) {
      console.error("Error sending code:", err);
      setError(err.message || 'Could not send verification code.');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Confirms the verification code entered by the user.
   */
  const confirmCode = async () => {
    if (!confirmationResult) {
      setError("Please request a code first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Use the confirmationResult object to confirm the code
      await confirmationResult.confirm(code);
      
      // At this point, the user is signed in.
      const currentUser = auth.currentUser;
      if (currentUser) {
        const idToken = await currentUser.getIdToken();
        // You can now use this token to authenticate with your backend
        await loginWithToken(idToken);
        router.back(); // Navigate away on successful login
      } else {
        throw new Error("Authentication failed: No user found.");
      }
    } catch (err: any) {
      console.error("Error confirming code:", err);
      setError(err.message || 'The code you entered is invalid.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.outerContainer}
    >
      {/* This modal component handles the reCAPTCHA flow */}
      <FirebaseRecaptchaVerifierModal
        ref={recaptchaVerifier}
        firebaseConfig={firebaseConfig}
        title="Confirm you're not a robot"
        cancelLabel="Close"
      />

      <Logo variant="wide" style={{ alignSelf: 'center', marginBottom: 24 }} />
      <View style={styles.loginCard}>
        <Text style={styles.heading}>Sign in</Text>

        {/* Show phone input if no code has been sent yet */}
        {!confirmationResult ? (
          <>
            <Text style={styles.label}>Phone Number</Text>
            <TextInput
              style={styles.input}
              placeholder="+1 555 555 5555"
              keyboardType="phone-pad"
              placeholderTextColor="#999999"
              onChangeText={setPhone}
              value={phone}
            />
            <TouchableOpacity
              style={[styles.primaryButton, (loading || phone.length < 10) && styles.disabledButton]}
              onPress={sendCode}
              disabled={loading || phone.length < 10}
            >
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Send Code</Text>}
            </TouchableOpacity>
          </>
        ) : (
          // Show code input after the code has been sent
          <>
            <Text style={styles.label}>Verification Code</Text>
            <TextInput
              style={styles.input}
              placeholder="123456"
              keyboardType="number-pad"
              placeholderTextColor="#999999"
              onChangeText={setCode}
              value={code}
              maxLength={6}
            />
            <TouchableOpacity
              style={[styles.primaryButton, (loading || code.length < 6) && styles.disabledButton]}
              onPress={confirmCode}
              disabled={loading || code.length < 6}
            >
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Confirm Code</Text>}
            </TouchableOpacity>
          </>
        )}

        {/* Your UI for other login methods can go here */}
        
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  outerContainer: {
    flex: 1,
    backgroundColor: '#f1f3f6',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  loginCard: {
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 24,
    width: '100%',
    maxWidth: 400,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 5,
  },
  heading: {
    fontSize: 24,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 24,
  },
  label: {
    fontSize: 16,
    marginBottom: 8,
    color: '#333',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 14,
    fontSize: 16,
    marginBottom: 16,
    backgroundColor: '#fff',
  },
  primaryButton: {
    backgroundColor: '#00715a',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 20,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  disabledButton: {
    backgroundColor: '#a9a9a9',
  },
  error: {
    color: 'red',
    textAlign: 'center',
    marginTop: 12,
  },
});
