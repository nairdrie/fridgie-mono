import { firebaseConfig } from '@/utils/firebase';
import { FirebaseRecaptchaVerifierModal } from 'expo-firebase-recaptcha';
import React, { createContext, useContext, useRef } from 'react';

interface RecaptchaContextType {
    recaptchaVerifier: React.MutableRefObject<any> | null;
}

const RecaptchaContext = createContext<RecaptchaContextType | null>(null);

export const RecaptchaProvider = ({ children }: { children: React.ReactNode }) => {
    const recaptchaVerifier = useRef<any>(null);

    const value = {
        recaptchaVerifier
    };

    return (
        <RecaptchaContext.Provider value={value}>
            <FirebaseRecaptchaVerifierModal
                ref={recaptchaVerifier}
                firebaseConfig={firebaseConfig}
                title="Confirm you're not a robot"
                cancelLabel="Close"
            />
            {children}
        </RecaptchaContext.Provider>
    );
};

export const useRecaptcha = () => {
    const context = useContext(RecaptchaContext);
    if (!context) {
        throw new Error('useRecaptcha must be used within a RecaptchaProvider');
    }
    return context;
};