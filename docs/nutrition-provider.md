# Fridgie Pro nutrition setup

Fridgie did not previously contain nutrition data or a nutrition provider. The
first implementation therefore treats every value as an estimate and never
derives calories or macros from an LLM. The provider is disabled by default;
goals and the planned/cooked meal workflow remain usable while nutrient totals
are explicitly unavailable.

## Provider boundary

`apps/api/utils/nutritionProvider.ts` contains the provider interface and the
initial Edamam Nutrition Analysis adapter. Edamam accepts the recipe title,
ingredient lines and yield, including measures such as “1 medium onion” that
cannot be responsibly converted to grams in Fridgie. Its documented full-recipe
endpoint is `POST https://api.edamam.com/api/nutrition-details`.

The API response is normalized to calories, protein, carbohydrates, fat and
fiber **per serving**. An incomplete response is rejected as a whole; missing
nutrients are never displayed as zero. The UI labels all values as estimates,
states that only meals in Fridgie are included, and avoids medical claims.

Before production enablement, the operator must:

1. Obtain signed/current terms for the intended plan that explicitly permit
   Fridgie's estimate storage and cache-invalidation behavior. Do not infer
   storage rights from API access alone; the provider agreement is authoritative.
2. Confirm the plan's current attribution and branding requirements. Fridgie
   displays “powered by Edamam” beside estimates, but the current agreement is
   authoritative if it requires a logo, link, or different wording.
3. Configure a provider-side **hard monthly spend, request, or licensing cap**
   at an approved amount. An emailed alert or application dashboard is not a
   hard cap. If the contracted plan cannot enforce one, leave analysis disabled.
4. Create an Edamam Nutrition Analysis API application at
   <https://developer.edamam.com/edamam-nutrition-api>, then add
   `EDAMAM_NUTRITION_APP_ID` and `EDAMAM_NUTRITION_APP_KEY` as server-only
   Cloud Run environment values/secrets. They must never use an `EXPO_PUBLIC_`
   prefix or be included in a mobile build.
5. Only after steps 1–4 are complete, set `NUTRITION_PROVIDER_ENABLED=true` in
   the API runtime. Credentials alone intentionally leave the provider disabled.
6. Deploy the API and open a Pro account's Nutrition screen with a week that
   contains at least one recipe. Confirm the first load creates a
   `recipeNutrition/{recipeId}` cache document and a second load makes no new
   provider request.

Optional server controls:

- `NUTRITION_MAX_NEW_ANALYSES_PER_REQUEST` — new cache misses analyzed by one
  weekly request; default `8`, maximum `30`.
- `NUTRITION_ANALYSIS_CONCURRENCY` — simultaneous provider calls; default `2`,
  maximum `5`.

These controls bound only one HTTP request's burst size and concurrency. They
do **not** bound aggregate provider cost: repeated weekly requests can analyze
different cache misses, and edited or deleted cached recipes can be analyzed
again. Some provider contracts also meter or license each analyzed recipe, not
just each HTTP call. Recipes beyond one request's budget are marked pending and
can be filled on a later refresh, so the provider-side hard monthly cap remains
the actual spend backstop.

## Storage and privacy

- Daily goals: `users/{uid}/settings/nutrition` in Firestore.
- Cooked-meal markers: `users/{uid}/nutritionConsumedMeals/{mealId}`.
- Provider estimates: `recipeNutrition/{recipeId}`, keyed by a SHA-256
  fingerprint of recipe title, yield and ingredient lines. Editing any of those
  fields invalidates the cached estimate automatically.
- Weekly list and meal ownership remains in Realtime Database as before.

The server sends recipe title, ingredient lines and serving yield to the
configured provider. It does not send user identity, dietary preferences,
allergens, group details, fridge photos, or source photos. Provider credentials
stay on the server. Provider errors are logged without recipe text, response
bodies, or credential-bearing URLs.

Both goal and weekly endpoints require a non-anonymous account and a verified
Fridgie Pro entitlement. Weekly and cooked-meal operations additionally verify
membership in the requested household. Dietary needs and allergen controls use
the existing free meal-preferences flow and are not read, moved, or gated by
the nutrition feature.

## Analysis semantics

Each planned meal contributes one estimated serving to the signed-in person's
view. The recipe's household scaling factor is deliberately not multiplied in:
that factor describes how much the household cooks, not how many servings this
person eats. “Consumed” means the user explicitly tapped **Mark cooked**; it is
a lightweight meal-status marker, not a comprehensive food or medical log.

Weekly goal comparison multiplies each daily target by seven. Since Fridgie may
contain only dinner plans, the UI explicitly warns that totals cover only meals
recorded in the selected Fridgie week.
