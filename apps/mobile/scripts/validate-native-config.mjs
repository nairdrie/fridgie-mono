import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const infoPlist = read('ios/Fridgie/Info.plist');
const appEntitlements = read('ios/Fridgie/Fridgie.entitlements');
const shareEntitlements = read('ios/SavetoFridgie/ShareExtension.entitlements');
const podfile = read('ios/Podfile');
const stripeInterop = read('node_modules/@stripe/stripe-react-native/ios/StripeSwiftInterop.h');
const eas = JSON.parse(read('eas.json'));

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
requireMatch(appEntitlements, /<string>merchant\.com\.nairdrie\.fridgie<\/string>/, 'the Stripe merchant entitlement');
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

console.log('Generated Android/iOS config contains the composed RevenueCat, share-intent, Stripe, and AdMob settings, including native compiler compatibility patches and the pinned EAS iOS toolchain.');
