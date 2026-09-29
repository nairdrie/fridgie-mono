# Claude connector (MCP)

Lets someone say *"plan three dinners for next week"* or *"make me a grocery
list for tacos"* in Claude and have it land in Fridgie: the meals on the plan,
the recipes in their cookbook, the ingredients on the list, sorted by aisle.

It is a remote [MCP](https://modelcontextprotocol.io) server served by this API
at **`/mcp`** (Streamable HTTP, stateless), with its own OAuth 2.1 authorization
server so it can be added to Claude as a **custom connector**.

## Using it

1. In the app: **Profile → Connect Claude**. The screen shows the connector URL.
2. In Claude (web, desktop or mobile): **Settings → Connectors → Add custom
   connector**. Name it Fridgie and paste `https://api.fridgie.ca/mcp`.
3. Claude opens Fridgie's sign-in page, which asks for a code. Tap
   **Get a code** in the app and type it in. That's it.

Claude Code: `claude mcp add --transport http fridgie https://api.fridgie.ca/mcp`,
then `/mcp` to sign in the same way.

Disconnect from the same screen in the app. Tokens stop working immediately.

## Tools

| Tool | What it does |
|---|---|
| `get_households` | The households (shared lists) the user is in; the default is marked |
| `get_meal_preferences` | Dietary needs, disliked ingredients, how many the household cooks for |
| `get_week_plan` | Meals planned and everything on the list for a week |
| `search_cookbook` / `get_recipe` | The user's saved recipes |
| `add_meal_to_plan` | Saves a recipe Claude wrote (or reuses a saved one), plans it on a day, and puts its ingredients on the list, scaled to the household |
| `save_recipe` | Cookbook only |
| `add_grocery_items` | Loose items ("milk, eggs") onto the list |

Everything that writes goes through the same code the app's own routes use:
`utils/mealPlan.ts` (shared with `POST /api/meal`), `utils/cookbookStore.ts`
(shared with `POST /api/cookbook`) and `utils/weekLists.ts` (shared with
`GET /api/list`). The app sees changes live through the list websocket, like
any other edit.

Recipes Claude writes are stored `visibility: 'private'` — they have no public
source, so by the Explore rule they are never shown to strangers.

## Signing in

There is no web login. The phone is already signed in, so it vouches for the
browser instead:

```
Claude ──register──▶ /oauth/register           (RFC 7591, open)
Claude ──redirect──▶ /oauth/authorize          page asks for the code
App    ──────────▶  POST /api/claude/link-code  8 chars, 10 min, single use
user types code ──▶ POST /oauth/authorize ──▶ 303 back to Claude with ?code
Claude ──────────▶  /oauth/token               PKCE (S256) required
Claude ──Bearer──▶  /mcp
```

The link code also carries the household that was open in the app (the default
target) and the phone's timezone (what "this week" means).

- Access tokens last 1 hour; refresh tokens 60 days and rotate on every use.
- Codes, tokens and client secrets are stored only as SHA-256 hashes.
- Redirect URIs must be https, loopback http, or a private-use scheme, and must
  match what the client registered. A bad one gets our own error page, never a
  redirect.
- Failed code entries are rate-limited per IP.
- Reconnecting the same client replaces its previous connection.

Discovery documents: `/.well-known/oauth-protected-resource[/mcp]` and
`/.well-known/oauth-authorization-server`. An unauthenticated call to `/mcp`
returns 401 with a `WWW-Authenticate` header pointing at them, which is how
Claude discovers that it needs to sign in.

## Storage

Firestore, all top-level collections: `mcpClients`, `mcpLinkCodes`,
`mcpAuthCodes`, `mcpGrants` (one per connection, which is what the app lists),
`mcpTokens`. Expiring records carry an `expireAt` timestamp. Expiry is enforced
in code, but to have Firestore delete dead records, turn on a TTL policy on
`expireAt` for each of those collections (Console → Firestore → TTL).

## Configuration

- `PUBLIC_BASE_URL` (optional): pins the origin used in the OAuth metadata,
  e.g. `https://api.fridgie.ca`. Without it the origin comes from the request's
  forwarded headers, which is right behind Cloud Run and for local testing.

No new secrets. The connector uses the API's existing Firebase credentials.

## Layout

| File | |
|---|---|
| `app.ts` | Hono routes: discovery, OAuth endpoints, `/mcp` |
| `tools.ts` | The MCP server and its tools, over a `FridgieBackend` |
| `backend.ts` / `firebaseBackend.ts` | That seam, and its real implementation |
| `oauthService.ts` | Clients, link codes, grants, tokens, over a `KvStore` |
| `oauthCore.ts` | Pure rules: PKCE, redirect URIs, code format |
| `store.ts` / `firestoreStore.ts` | The `KvStore` in memory (tests) and in Firestore |
| `weeks.ts` | `"this"` / `"next"` / a date → the Sunday key a list is filed under |
| `authorizePage.ts` | The sign-in page |

Tests: `tests/mcpOauth.test.ts` (the pure rules) and `tests/mcpFlow.test.ts`
(the whole flow, from registration through tool calls, in memory).

Try it locally with the MCP Inspector: `make api`, then
`npx @modelcontextprotocol/inspector` and connect to `http://localhost:3000/mcp`.
