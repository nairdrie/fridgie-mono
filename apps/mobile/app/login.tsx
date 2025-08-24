import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

// ✅ Updated imports for the final, correct flow
import {
  ConfirmationResult,
  PhoneAuthProvider,
  RecaptchaVerifier,
  linkWithCredential,
  signInWithCredential,
  signInWithPhoneNumber,
} from 'firebase/auth';

// --- Your Project's Imports ---
// IMPORTANT: Make sure you have a firebaseConfig.js file that exports your config
import { auth, firebaseConfig } from '@/utils/firebase';
import { FirebaseRecaptchaVerifierModal } from 'expo-firebase-recaptcha';
import { useRouter } from 'expo-router';
import Logo from '../components/Logo';
import { loginWithToken } from '../utils/api';
import { toE164 } from '../utils/utils';

export default function LoginScreen() {
  const router = useRouter();
  const recaptchaVerifier = useRef<any>(null);

  // --- State Management ---
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);
  
  // ✅ Changed state to a simple boolean to control the modal
  const [showConflictModal, setShowConflictModal] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'web' && !recaptchaVerifier.current) {
      recaptchaVerifier.current = new RecaptchaVerifier(auth, 'recaptcha-container', { 'size': 'invisible' });
    }

    // ✅ Add this cleanup function
    // This will run when the component is unmounted
    return () => {
      recaptchaVerifier.current?.clear();
    };
  }, []);

  const sendCode = async () => {
    // This function remains the same
    setLoading(true);
    setError(null);
    try {
      const e164PhoneNumber = toE164(phone);
      if (!recaptchaVerifier.current) { throw new Error("Recaptcha Verifier is not available."); }
      const confirmation = await signInWithPhoneNumber(auth, e164PhoneNumber, recaptchaVerifier.current);
      setConfirmationResult(confirmation);
    } catch (err: any) {
      setError(err.message || 'Could not send verification code.');
    } finally {
      setLoading(false);
    }
  };

  const confirmCode = async () => {
    if (!confirmationResult) return;
    setLoading(true);
    setError(null);
    try {
      const anonymousUser = auth.currentUser;
      const phoneCredential = PhoneAuthProvider.credential(confirmationResult.verificationId, code);

      if (anonymousUser && anonymousUser.isAnonymous) {
        await linkWithCredential(anonymousUser, phoneCredential);
      } else {
        await signInWithCredential(auth, phoneCredential);
      }
      
      const finalUser = auth.currentUser;
      if (finalUser) {
        const idToken = await finalUser.getIdToken();
        await loginWithToken(idToken);
        if(router.canGoBack()) {
          router.back();
        } else {
          router.push('/');
        }
      }
    } catch (err: any) {
      // ✅ Use the correct error code and just show the modal
      if (err.code === 'auth/account-exists-with-different-credential' || err.code === 'auth/credential-already-in-use') {
        setShowConflictModal(true);
      } else {
        setError(err.message || 'The code you entered is invalid.');
      }
    } finally {
      setLoading(false);
    }
  };

  // ✅ Reworked handler to be simpler and more reliable
  const handleSignInToExistingAccount = async () => {
    if (!confirmationResult || !code) return;
    setLoading(true);
    setShowConflictModal(false); // Close the modal
    try {
      // Perform a direct sign-in using the already verified code.
      // This signs out the anonymous user and signs in the permanent one.
      const credential = await confirmationResult.confirm(code);
      if (credential.user) {
        const idToken = await credential.user.getIdToken();
        await loginWithToken(idToken);
        if(router.canGoBack()) {
          router.back();
        } else {
          router.push('/');
        }
      }
    } catch (err: any) {
      setError('Failed to sign in. Please try entering the code again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.outerContainer}
    >
      {Platform.OS === 'web' ? (
        <View id="recaptcha-container" />
      ) : (
        <FirebaseRecaptchaVerifierModal
          ref={recaptchaVerifier}
          firebaseConfig={firebaseConfig}
          title="Confirm you're not a robot"
          cancelLabel="Close"
        />
      )}
      
      <Modal
        visible={showConflictModal} // Controlled by the new boolean state
        transparent={true}
        animationType="fade"
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Account Exists</Text>
            <Text style={styles.modalMessage}>
              This phone number is already in use. Would you like to sign in to that account? 
              Your current work will be discarded.
            </Text>
            <View style={styles.modalButtons}>
              <Button title="Cancel" onPress={() => setShowConflictModal(false)} />
              <Button title="Sign In" onPress={handleSignInToExistingAccount} />
            </View>
          </View>
        </View>
      </Modal>

      {/* The rest of your UI (Logo, loginCard, inputs) remains the same */}
      <Logo variant="wide" style={{ alignSelf: 'center', marginBottom: 24 }} />
      <View style={styles.loginCard}>
        <Text style={styles.heading}>Sign in</Text>
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
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    </KeyboardAvoidingView>
  );
}

// Your existing styles plus the modal styles
const styles = StyleSheet.create({
  outerContainer: { flex: 1, backgroundColor: '#f1f3f6', justifyContent: 'center', alignItems: 'center', padding: 16 },
  loginCard: { backgroundColor: 'white', borderRadius: 12, padding: 24, width: '100%', maxWidth: 400, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 10, elevation: 5 },
  heading: { fontSize: 24, fontWeight: '600', textAlign: 'center', marginBottom: 24 },
  label: { fontSize: 16, marginBottom: 8, color: '#333' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 14, fontSize: 16, marginBottom: 16, backgroundColor: '#fff' },
  primaryButton: { backgroundColor: '#00715a', paddingVertical: 14, borderRadius: 8, alignItems: 'center', marginBottom: 20 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  disabledButton: { backgroundColor: '#a9a9a9' },
  error: { color: 'red', textAlign: 'center', marginTop: 12 },
  modalContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.5)' },
  modalContent: { backgroundColor: 'white', padding: 20, borderRadius: 10, width: '80%', alignItems: 'center' },
  modalTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
  modalMessage: { textAlign: 'center', marginBottom: 20 },
  modalButtons: { flexDirection: 'row', justifyContent: 'space-around', width: '100%' },
});