# Auth provider setup — the console half

The app's sign-in code is complete. What it depends on and cannot ship is the
per-provider configuration inside the Firebase console for **`grocerease-5abbb`**
and, for Apple, inside the Apple Developer portal. This file records that half,
because nothing in the repo enforces it and the failure it produces is opaque.

## The error this file exists for

```
auth/operation-not-allowed
The identity provider configuration is not found.
```

That is Firebase's Identity Toolkit saying **the provider is switched off for this
project**. It is raised before the credential is examined at all, so it says
nothing about the token, the nonce, the bundle id, or the device. No code change
fixes it. Enable the provider.

## Apple — what to do

**1. Apple Developer portal** (only needed once per bundle id)

Under Certificates, Identifiers & Profiles → Identifiers, open the App ID for
`com.nairdrie.fridgie` and tick the **Sign in with Apple** capability. `app.json`
already sets `"usesAppleSignIn": true`, so the entitlement is in the build; this
is the server side agreeing to honour it.

**2. Firebase console** — Authentication → Sign-in method → **Apple** → Enable.

This toggle alone clears `auth/operation-not-allowed`.

Leave the rest of that screen alone. All of it serves the **web** redirect flow,
which we do not use — the app only ever signs in through the native sheet:

- **Services ID** — the console labels it "not required for Apple" itself.
- **OAuth code flow configuration (optional)** — Apple Team ID, Key ID, private
  key `.p8`. Fill these in before App Store submission, though: Apple requires an
  app offering Sign in with Apple to also delete accounts and revoke the token,
  and Firebase can only revoke with the code flow configured.
- **The authorisation callback URL** — `https://grocerease-5abbb.firebaseapp.com/__auth/handler`.
  The screen says "to complete setup, add this to your app configuration in the
  Apple Developer console", which reads as mandatory and is not. It is the
  redirect Apple sends a *browser* back to. Adding it, and the domain
  verification it leads to, achieves nothing for a native sign-in.

**3. Make `com.nairdrie.fridgie` an accepted audience.**

Apple stamps the requesting app's bundle id into the identity token's `aud`
claim, and Firebase rejects an audience it does not recognise. Register the iOS
app in the Firebase project (Project settings → Your apps → Add app → iOS,
bundle id `com.nairdrie.fridgie`) so that id is one Firebase accepts. We use the
Firebase **JS SDK**, so the `GoogleService-Info.plist` it offers you at the end is
not needed in the repo — `utils/firebase.ts` carries the web config. Registering
the app is the point; the file is a by-product.

A wrong audience is a *different* error — `auth/invalid-credential`, usually
worded "the audience in ID Token does not match the expected audience" — so if
that is what you get after step 2, this is the step that was missed.

## Testing it

Apple sign-in cannot be tested in Expo Go or the iOS simulator.

Expo Go signs the token with **its own** bundle id, `host.exp.Exponent`, which
Firebase will reject as an audience no matter how correct the project config is.
Use a dev build — `expo-dev-client` is already a dependency and the `development`
EAS profile builds one — on a real device signed into an Apple ID.

## The nonce

`signInWithApple` in `utils/socialAuth.ts` generates 32 random bytes, sends
Apple the SHA-256 of them and hands Firebase the raw value as `rawNonce`.
Firebase re-hashes the raw value and compares it to the `nonce` claim in the
token. Both halves have to be present and matched: sending a hashed nonce to
Apple without passing the raw one to Firebase fails with
`auth/invalid-credential`, and dropping the nonce entirely leaves an identity
token that can be replayed. Do not "simplify" one side of it away.

## The other two providers

Same screen, same failure mode if disabled.

- **Google** — the OAuth clients live in Google Cloud project `598650352064`, not
  in the Firebase project `725621365755`. That is deliberate and documented at the
  top of `utils/socialAuth.ts`: the Firebase console's Google provider is wired to
  that project, which is why those audiences are accepted.
- **Facebook** — needs the app id and app secret from the Meta app `776186408706339`.
  The client token in `app.json` is still the `REPLACE_WITH_FACEBOOK_CLIENT_TOKEN`
  placeholder, so Facebook sign-in cannot work in a build made from the repo as it
  stands.
