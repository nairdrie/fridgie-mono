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

## Google — the audience has to belong to this project

Enabling the provider is the same screen and the same failure mode if it's off.
Google then has a second requirement Apple's flow doesn't make obvious.

The client id handed to `GoogleSignin.configure` is what Google stamps into the
id token's `aud` claim, and Firebase accepts an audience only when it is either

- an OAuth client owned by `grocerease-5abbb` (project number `725621365755`), or
- listed under Authentication → Sign-in method → **Google** → Web SDK
  configuration → **Whitelist client IDs from external projects**.

`utils/socialAuth.ts` ships ids owned by Google Cloud project `598650352064`,
which is neither, so signing in on a real device fails at
`signInWithCredential`:

```
auth/invalid-credential
Firebase: Invalid Idp Response: the Google id_token is not allowed to be used
with this application. Its audience (OAuth 2.0 client ID) is
598650352064-bjkgnsj14of6fs4f9ggkmi9tlqptuiat.apps.googleusercontent.com, which
is not authorized to be used in the project with project_number: 725621365755.
```

Note *which* id the error names. On Android the token is minted for the **web**
client — `webClientId`, not the Android client — so that is the audience Firebase
checks and the one that has to be authorised. On iOS it's `iosClientId`.

### The two ways out

**Whitelist the external ids.** Paste both `598650352064-…` ids into the
whitelist field above. No code change, and it keeps working with whatever
`598650352064` already has registered — including the Android OAuth client that
the debug SHA-1 is signed against, which is what lets `GoogleSignin.signIn()`
return a token at all today.

**Or move the audience into the Firebase project.** Point `GOOGLE_WEB_CLIENT_ID`
at `725621365755-vqpeiaprvh5jlcpnlkuum4m7bg7025qb.apps.googleusercontent.com` —
already in `google-services.json`, already owned by `grocerease-5abbb`. Firebase
accepts it with nothing whitelisted, but Google will only *mint* against it once
the app is registered in the same project, so this needs, first:

- the release **and** debug SHA-1 registered on the Android app in
  Project settings → Your apps, then a re-downloaded `google-services.json`;
- an iOS OAuth client for `com.nairdrie.fridgie` in `grocerease-5abbb`, whose
  reversed id replaces the `iosUrlScheme` in `app.json`.

Skip the SHA-1 half and the audience error is simply replaced by
`DEVELOPER_ERROR` (status code 10) from the Google SDK, before Firebase is ever
reached.

The `google-services.json` in the repo is evidence the first step hasn't been
done: its only `oauth_client` entry is `client_type: 3`, the web client. The
Gradle plugin emits a `client_type: 1` entry per registered signing certificate,
so a file with none means no SHA-1 was registered when it was downloaded.

## Facebook

Needs the app id and app secret from the Meta app `776186408706339`. The client
token in `app.json` is still the `REPLACE_WITH_FACEBOOK_CLIENT_TOKEN`
placeholder, so Facebook sign-in cannot work in a build made from the repo as it
stands.
