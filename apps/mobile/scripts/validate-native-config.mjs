import { readFileSync } from 'node:fs';
import stripeWalletConfig from '../config/stripe-wallets.cjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const infoPlist = read('ios/Fridgie/Info.plist');
const appEntitlements = read('ios/Fridgie/Fridgie.entitlements');
const shareEntitlements = read('ios/SavetoFridgie/ShareExtension.entitlements');
const podfile = read('ios/Podfile');
const stripeInterop = read('node_modules/@stripe/stripe-react-native/ios/StripeSwiftInterop.h');
const eas = JSON.parse(read('eas.json'));
const stripeWallets = stripeWalletConfig.resolveStripeWalletBuildConfig(process.env);

const requireMatch = (value, pattern, label) => {
  if (!pattern.test(value)) throw new Error(`Generated native config is missing ${label}.`);
};
const requireExactlyOnce = (value, needle, label) => {
  if (value.split(needle).length - 1 !== 1) {
    throw new Error(`Generated native config must contain ${label} exactly once.`);
  }
};

const mainActivity = manifest.match(/<activity\b(?=[^>]*android:name="\.MainActivity")[^>]*>/)?.[0] ?? '';
requireMatch(mainActivity, /android:launchMode="singleTop"/, 'RevenueCat-safe MainActivity singleTop launch mode');
requireMatch(manifest, /android:scheme="fridgie"/, 'the fridgie Android deep-link scheme');
requireMatch(manifest, /android:scheme="exp\+fridgie"/, 'the Expo development-client Android scheme');
requireMatch(manifest, /android:name="android\.intent\.action\.SEND"/, 'the Android share intent');
requireMatch(manifest, /android:mimeType="text\/\*"/, 'the Android text share MIME filter');
requireMatch(manifest, /com\.google\.android\.gms\.ads\.APPLICATION_ID[^>]+ca-app-pub-\d{16}~\d{10}/, 'the AdMob Android application id');
requireExactlyOnce(manifest, 'com.google.android.gms.ads.APPLICATION_ID', 'the AdMob Android application-id metadata');

requireMatch(infoPlist, /<key>GADApplicationIdentifier<\/key>\s*<string>ca-app-pub-\d{16}~\d{10}<\/string>/, 'the AdMob iOS application id');
requireMatch(infoPlist, /<string>fridgie<\/string>/, 'the fridgie iOS URL scheme');
requireMatch(infoPlist, /<string>exp\+fridgie<\/string>/, 'the Expo development-client iOS scheme');
if (stripeWallets.applePayEnabled) {
  const merchantIdentifier = stripeWallets.merchantIdentifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  requireMatch(
    appEntitlements,
    new RegExp(`<key>com\\.apple\\.developer\\.in-app-payments<\\/key>\\s*<array>\\s*<string>${merchantIdentifier}<\\/string>\\s*<\\/array>`),
    'exactly the configured Stripe merchant entitlement',
  );
} else if (/com\.apple\.developer\.in-app-payments/.test(appEntitlements)) {
  throw new Error('Generated native config includes Apple Pay although EXPO_PUBLIC_STRIPE_APPLE_PAY_ENABLED is not true.');
}
requireMatch(appEntitlements, /<string>group\.com\.nairdrie\.fridgie<\/string>/, 'the host app group entitlement');
requireMatch(shareEntitlements, /<string>group\.com\.nairdrie\.fridgie<\/string>/, 'the share-extension app group entitlement');
requireMatch(podfile, /Fridgie: keep generated pods compatible[\s\S]+minimum_ios = Gem::Version\.new\('15\.1'\)/, 'the CocoaPods iOS 15.1 target floor');
requireMatch(podfile, /pod_target\.name == 'fmt'[\s\S]+CLANG_CXX_LANGUAGE_STANDARD'\] = 'c\+\+17'/, 'the Apple clang 21 fmt compatibility setting');
requireMatch(stripeInterop, /typedef NS_ENUM\(NSInteger, STPPaymentStatus\);/, 'the Xcode 26+ Stripe payment-status enum compatibility patch');

const requiredIosImage = 'macos-sequoia-15.6-xcode-26.2';
for (const profile of ['preview', 'production']) {
  if (eas.build?.[profile]?.ios?.image !== requiredIosImage) {
    throw new Error(`EAS ${profile} must use the validated ${requiredIosImage} iOS image.`);
  }
}

console.log(`Generated Android/iOS config contains the composed RevenueCat, share-intent, Stripe, and AdMob settings, including native compiler compatibility patches, ${stripeWallets.applePayEnabled ? 'enabled Apple Pay' : 'card checkout without Apple Pay'}, and the pinned EAS iOS toolchain.`);
