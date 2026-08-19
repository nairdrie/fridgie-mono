import type { Context, Next } from 'hono'

/**
 * Rejects anonymous sign-ins.
 *
 * `authorizedFetch` calls `signInAnonymously` whenever there is no user, so
 * every install holds a valid token within seconds of first launch. That is
 * fine for lists — they are the reason someone tries the app — but it means
 * anything expensive or account-shaped is otherwise open to anyone who
 * downloads it. Recipe generation and meal suggestions each cost real money per
 * call, and a cookbook belongs to a person rather than to a device.
 *
 * Sorting a list by aisle (`/list/categorize/:id`) is deliberately NOT here.
 * It is an AI route, but it is also part of the grocery list itself, and
 * `itemCategoryCache` means a repeat item never reaches the model at all.
 *
 * The client mirrors this by prompting for sign-up, but that is a courtesy:
 * this is the check that actually holds, because a client-side redirect is
 * bypassed by anyone talking to the API directly.
 *
 * Linking an anonymous account (login.tsx uses `linkWithCredential`) keeps the
 * same uid and flips the provider, so everything created while anonymous
 * survives sign-up — nothing here has to migrate data.
 */
export async function requireAccount(c: Context, next: Next) {
  if (c.get('isAnonymous')) {
    // `account_required` is what the client keys the sign-up bump off; the
    // status alone can't distinguish this from any other 403.
    return c.json(
      { error: 'account_required', message: 'Create an account to use this feature.' },
      403,
    )
  }
  return await next()
}
