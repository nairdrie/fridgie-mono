// The Claude connector end to end, exactly as Claude drives it: discover,
// register, send the user to sign in with the code from their app, trade the
// code for tokens, then call tools — against an in-memory store and backend.

import { beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { createMcpApp } from '../mcp/app'
import { memoryStore } from '../mcp/store'
import { createOAuthService, type OAuthService } from '../mcp/oauthService'
import { formatLinkCode } from '../mcp/oauthCore'
import type { FridgieBackend, Household } from '../mcp/backend'
import type { Item, Meal, Recipe } from '../utils/types'

const BASE = 'https://api.fridgie.test'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const UID = 'user-1'

interface FakeList { listId: string; weekStart: string; meals: Meal[]; items: Item[] }

function fakeBackend() {
  const households: Household[] = [
    { id: 'home', name: 'Home', isOwner: true, memberCount: 2, householdSize: 2 },
    { id: 'cottage', name: 'Cottage', isOwner: false, memberCount: 5 },
  ]
  const lists = new Map<string, FakeList>()
  const recipes = new Map<string, Recipe>()
  const cookbook = new Set<string>()
  let n = 0

  const backend: FridgieBackend = {
    async listHouseholds(uid) { return uid === UID ? households : [] },
    async getWeekList(groupId, weekStart) {
      const key = `${groupId}:${weekStart}`
      if (!lists.has(key)) lists.set(key, { listId: `list-${++n}`, weekStart, meals: [], items: [] })
      const list = lists.get(key)!
      return { ...list, sort: 'category', meals: [...list.meals], items: [...list.items] }
    },
    async appendItems(groupId, listId, rows) {
      const list = [...lists.values()].find((l) => l.listId === listId)!
      const items = rows.map((r) => ({ id: `item-${++n}`, text: r.text, checked: false, isSection: false, listOrder: `0|${n}`, ...(r.quantity ? { quantity: r.quantity } : {}) }))
      list.items.push(...items)
      return items
    },
    async addRecipeToList(groupId, listId, recipe, options) {
      const list = [...lists.values()].find((l) => l.listId === listId)!
      const meal: Meal = { id: `meal-${++n}`, listId, name: recipe.name, recipeId: recipe.id, ...(options.dayOfWeek ? { dayOfWeek: options.dayOfWeek } : {}) }
      list.meals.push(meal)
      const items = options.includeIngredients === false ? [] : recipe.ingredients.map((i) => ({
        id: `item-${++n}`, text: i.name, checked: false, isSection: false, listOrder: `0|${n}`, mealId: meal.id, ...(i.quantity ? { quantity: i.quantity } : {}),
      }))
      list.items.push(...items)
      return { meal, items }
    },
    async createRecipe(uid, input) {
      const recipe = { id: `recipe-${++n}`, ...input, description: input.description ?? '', instructions: input.instructions ?? [], createdBy: uid, visibility: 'private' } as Recipe
      recipes.set(recipe.id, recipe)
      return recipe
    },
    async addToCookbook(uid, recipeId) { cookbook.add(recipeId); return recipes.has(recipeId) },
    async getRecipe(id) { return recipes.get(id) ?? null },
    async getCookbook() { return [...cookbook].map((id) => recipes.get(id)!).filter(Boolean) },
    async getPreferences() { return { dietaryNeeds: ['vegetarian'], dislikedIngredients: 'cilantro' } },
  }
  return { backend, lists, recipes, cookbook }
}

let oauth: OAuthService
let app: ReturnType<typeof createMcpApp>
let fake: ReturnType<typeof fakeBackend>

beforeEach(() => {
  process.env.PUBLIC_BASE_URL = BASE
  oauth = createOAuthService(memoryStore())
  fake = fakeBackend()
  app = createMcpApp({ oauth, backend: fake.backend })
})

const request = (path: string, init?: RequestInit) => app.request(`${BASE}${path}`, init)

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
})

async function register(extra: Record<string, unknown> = {}) {
  const res = await request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], ...extra }),
  })
  expect(res.status).toBe(201)
  return res.json() as Promise<{ client_id: string; client_secret?: string }>
}

async function connect(options: { groupId?: string; timezone?: string; clientId?: string } = {}) {
  const client_id = options.clientId ?? (await register()).client_id
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const params = {
    response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'xyz', scope: 'fridgie',
  }
  const page = await request(`/oauth/authorize?${new URLSearchParams(params)}`)
  expect(page.status).toBe(200)
  expect(await page.text()).toContain('Connect Claude')

  const { code: linkCode } = await oauth.createLinkCode(UID, { groupId: options.groupId, timezone: options.timezone })
  const approved = await request('/oauth/authorize', form({ ...params, link_code: formatLinkCode(linkCode).toLowerCase() }))
  expect(approved.status).toBe(303)
  const location = new URL(approved.headers.get('location')!)
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT)
  expect(location.searchParams.get('state')).toBe('xyz')

  const tokenRes = await request('/oauth/token', form({
    grant_type: 'authorization_code', client_id, code: location.searchParams.get('code')!,
    code_verifier: verifier, redirect_uri: REDIRECT,
  }))
  expect(tokenRes.status).toBe(200)
  const tokens = await tokenRes.json() as { access_token: string; refresh_token: string; token_type: string }
  expect(tokens.token_type).toBe('Bearer')
  return { client_id, ...tokens }
}

let rpcId = 0
async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  return { status: res.status, body: await res.json() as any }
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const { status, body } = await rpc(token, 'tools/call', { name, arguments: args })
  expect(status).toBe(200)
  const text = body.result.content[0].text as string
  return { isError: !!body.result.isError, text, data: body.result.isError ? null : JSON.parse(text) }
}

describe('discovery', () => {
  test('an unauthenticated call points the client at the metadata', async () => {
    const res = await request('/mcp', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`)

    const resource = await (await request('/.well-known/oauth-protected-resource/mcp')).json() as any
    expect(resource).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] })

    const server = await (await request('/.well-known/oauth-authorization-server')).json() as any
    expect(server).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
    })
  })
})

describe('authorization', () => {
  test('the full flow yields a working token', async () => {
    const { access_token } = await connect()
    const init = await rpc(access_token, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    })
    expect(init.body.result.serverInfo.name).toBe('fridgie')
    expect(init.body.result.instructions).toContain('add_meal_to_plan')

    const tools = await rpc(access_token, 'tools/list')
    expect(tools.body.result.tools.map((t: any) => t.name).sort()).toEqual([
      'add_grocery_items', 'add_meal_to_plan', 'get_households', 'get_meal_preferences',
      'get_recipe', 'get_week_plan', 'save_recipe', 'search_cookbook',
    ])
  })

  test('a wrong link code re-renders the page, and codes are single-use', async () => {
    const { client_id } = await register()
    const verifier = randomBytes(32).toString('base64url')
    const params = {
      response_type: 'code', client_id, redirect_uri: REDIRECT,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }
    const wrong = await request('/oauth/authorize', form({ ...params, link_code: 'ABCD-EFGH' }))
    expect(wrong.status).toBe(400)
    expect(await wrong.text()).toContain('didn&#39;t work')

    const { code } = await oauth.createLinkCode(UID)
    expect((await request('/oauth/authorize', form({ ...params, link_code: code }))).status).toBe(303)
    expect((await request('/oauth/authorize', form({ ...params, link_code: code }))).status).toBe(400)
  })

  test('an unregistered redirect URI is never redirected to', async () => {
    const { client_id } = await register()
    const res = await request(`/oauth/authorize?${new URLSearchParams({
      response_type: 'code', client_id, redirect_uri: 'https://evil.example/cb',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256',
    })}`)
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  test('missing PKCE goes back to the client as an error', async () => {
    const { client_id } = await register()
    const res = await request(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, state: 's' })}`)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('invalid_request')
    expect(location.searchParams.get('state')).toBe('s')
  })

  test('a code can\'t be exchanged with the wrong verifier, or twice', async () => {
    const { client_id } = await register()
    const verifier = randomBytes(32).toString('base64url')
    const params = {
      response_type: 'code', client_id, redirect_uri: REDIRECT,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }
    const { code: link } = await oauth.createLinkCode(UID)
    const redirect = await request('/oauth/authorize', form({ ...params, link_code: link }))
    const code = new URL(redirect.headers.get('location')!).searchParams.get('code')!

    const bad = await request('/oauth/token', form({ grant_type: 'authorization_code', client_id, code, code_verifier: randomBytes(32).toString('base64url'), redirect_uri: REDIRECT }))
    expect(bad.status).toBe(400)
    expect((await bad.json() as any).error).toBe('invalid_grant')

    const again = await request('/oauth/token', form({ grant_type: 'authorization_code', client_id, code, code_verifier: verifier, redirect_uri: REDIRECT }))
    expect(again.status).toBe(400)
  })

  test('refresh rotates the tokens, and the old refresh token stops working', async () => {
    const { client_id, refresh_token } = await connect()
    const first = await request('/oauth/token', form({ grant_type: 'refresh_token', client_id, refresh_token }))
    expect(first.status).toBe(200)
    const rotated = await first.json() as any
    expect(rotated.refresh_token).not.toBe(refresh_token)
    expect((await rpc(rotated.access_token, 'tools/list')).status).toBe(200)

    const replay = await request('/oauth/token', form({ grant_type: 'refresh_token', client_id, refresh_token }))
    expect(replay.status).toBe(400)
  })

  test('confidential clients must authenticate', async () => {
    const { client_id, client_secret } = await register({ token_endpoint_auth_method: 'client_secret_basic' })
    expect(client_secret).toBeTruthy()
    const res = await request('/oauth/token', form({ grant_type: 'refresh_token', client_id, refresh_token: 'x' }))
    expect(res.status).toBe(401)
    const basic = btoa(`${client_id}:${client_secret}`)
    const withSecret = await request('/oauth/token', {
      ...form({ grant_type: 'refresh_token', refresh_token: 'x' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
    })
    expect(withSecret.status).toBe(400) // authenticated; the refresh token itself is bogus
  })

  test('disconnecting from the app kills the token immediately', async () => {
    const { access_token } = await connect()
    const [grant] = await oauth.listGrants(UID)
    expect(grant!.clientName).toBe('Claude')
    expect(await oauth.revokeGrant('someone-else', grant!.id)).toBe(false)
    expect(await oauth.revokeGrant(UID, grant!.id)).toBe(true)
    expect((await rpc(access_token, 'tools/list')).status).toBe(401)
    expect(await oauth.listGrants(UID)).toEqual([])
  })

  test('reconnecting the same client replaces its connection', async () => {
    const first = await connect()
    const second = await connect({ clientId: first.client_id })
    expect((await oauth.listGrants(UID)).length).toBe(1)
    expect((await rpc(first.access_token, 'tools/list')).status).toBe(401)
    expect((await rpc(second.access_token, 'tools/list')).status).toBe(200)

    // A different client is a separate connection.
    await connect()
    expect((await oauth.listGrants(UID)).length).toBe(2)
  })
})

describe('tools', () => {
  test('add_meal_to_plan saves the recipe, plans it and fills the list', async () => {
    const { access_token } = await connect({ groupId: 'home', timezone: 'America/Toronto' })
    const res = await callTool(access_token, 'add_meal_to_plan', {
      day: 'Tuesday',
      recipe: {
        name: 'Mushroom risotto',
        servings: 4,
        ingredients: [
          { name: 'arborio rice', quantity: '1.5 cup' },
          { name: 'cremini mushrooms', quantity: '300 g' },
          { name: 'parmesan' },
        ],
        instructions: ['Toast the rice.', 'Add stock slowly.'],
        tags: ['Vegetarian'],
      },
    })
    expect(res.isError).toBe(false)
    expect(res.data).toMatchObject({ added: 'Mushroom risotto', household: 'Home', week: 'this week', day: 'Tuesday', saved_to_cookbook: true })
    expect(res.data.groceries_added).toEqual(['1.5 cup arborio rice', '300 g cremini mushrooms', 'parmesan'])
    expect(fake.cookbook.has(res.data.recipe_id)).toBe(true)

    const plan = await callTool(access_token, 'get_week_plan', {})
    expect(plan.data.meals).toEqual([{ name: 'Mushroom risotto', day: 'Tuesday', recipe_id: res.data.recipe_id }])
    expect(plan.data.groceries).toHaveLength(3)
    expect(plan.data.groceries[0]).toMatchObject({ name: 'arborio rice', for_meal: 'Mushroom risotto' })
  })

  test('a saved recipe can be planned again by id', async () => {
    const { access_token } = await connect({ groupId: 'home' })
    const saved = await callTool(access_token, 'save_recipe', {
      recipe: { name: 'Pancakes', ingredients: [{ name: 'flour', quantity: '2 cup' }] },
    })
    const found = await callTool(access_token, 'search_cookbook', { query: 'pancake' })
    expect(found.data.recipes.map((r: any) => r.id)).toEqual([saved.data.recipe_id])

    const planned = await callTool(access_token, 'add_meal_to_plan', { recipe_id: saved.data.recipe_id, week: 'next', add_ingredients_to_list: false })
    expect(planned.data).toMatchObject({ added: 'Pancakes', week: 'next week', groceries_added: [] })
  })

  test('add_grocery_items goes to the linked household, or the one asked for', async () => {
    const { access_token } = await connect({ groupId: 'home' })
    const home = await callTool(access_token, 'add_grocery_items', { items: [{ name: 'milk', quantity: '2 L' }, { name: 'bananas' }] })
    expect(home.data).toMatchObject({ household: 'Home', added: ['2 L milk', 'bananas'] })

    const cottage = await callTool(access_token, 'add_grocery_items', { household_id: 'cottage', items: [{ name: 'firewood' }] })
    expect(cottage.data.household).toBe('Cottage')

    const unknown = await callTool(access_token, 'add_grocery_items', { household_id: 'nope', items: [{ name: 'x' }] })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('get_households')
  })

  test('preferences and households are readable', async () => {
    const { access_token } = await connect({ groupId: 'home' })
    const prefs = await callTool(access_token, 'get_meal_preferences')
    expect(prefs.data).toMatchObject({ dietary_needs: ['vegetarian'], disliked_ingredients: 'cilantro', cooks_for: 2 })
    const households = await callTool(access_token, 'get_households')
    expect(households.data.households[0]).toMatchObject({ id: 'home', default: true })
  })

  test('someone else\'s private recipe is invisible', async () => {
    const { access_token } = await connect()
    fake.recipes.set('secret', { id: 'secret', name: 'Secret', description: '', ingredients: [], instructions: [], createdBy: 'other', visibility: 'private' })
    expect((await callTool(access_token, 'get_recipe', { recipe_id: 'secret' })).isError).toBe(true)
    expect((await callTool(access_token, 'add_meal_to_plan', { recipe_id: 'secret' })).isError).toBe(true)
  })

  test('bad arguments are reported, not thrown', async () => {
    const { access_token } = await connect()
    expect((await callTool(access_token, 'add_meal_to_plan', {})).isError).toBe(true)
    expect((await callTool(access_token, 'get_week_plan', { week: 'someday' })).text).toContain('Unrecognised week')
  })
})
