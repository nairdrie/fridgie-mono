import { describe, expect, test } from 'bun:test'
import { extractMainContent, extractRecipeJsonLd } from '../utils/recipeExtract'

const page = (head: string, body = '<main><p>nothing here</p></main>') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

const ldJson = (value: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(value)}</script>`

const RECIPE = {
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Chili Crispy Pork Noodles',
  recipeIngredient: ['8 oz Ground pork', '1 1/2 cups Green cabbage, thinly sliced'],
  recipeInstructions: ['Heat a large skillet.', 'Add the pork.'],
}

describe('extractRecipeJsonLd', () => {
  test('reads a real Next.js recipe page whose markup renders empty', async () => {
    // The page this importer failed on. Its <main> is Suspense placeholders and
    // the recipe body never reaches the server-rendered HTML, so JSON-LD is the
    // only copy of the recipe that a fetch can see.
    const html = await Bun.file(`${import.meta.dir}/fixtures/nextjs-recipe-page.html`).text()
    const recipe = extractRecipeJsonLd(html)

    expect(recipe).not.toBeNull()
    expect(recipe!.name).toBe('Chili Crispy Pork Noodles')
    expect(recipe!.ingredients).toHaveLength(10)
    expect(recipe!.ingredients[0]).toBe('8 oz Ground pork, 20–30% fat preferred')
    expect(recipe!.instructions).toHaveLength(17)
    expect(recipe!.instructions[0]).toBe('Heat a large skillet over medium-high heat.')
    expect(recipe!.photoURL).toContain('recipe-images/')
    expect(recipe!.recipeYield).toBe('2 servings')
    expect(recipe!.totalTime).toBe('PT15M')
    // keywords + recipeCategory + recipeCuisine all feed the tag mapping.
    expect(recipe!.keywords.length).toBeGreaterThan(0)
  })

  test('finds the Recipe among unrelated blocks on the same page', () => {
    // Real pages lead with Organization/WebSite and bury the Recipe mid-list.
    const html = page(
      ldJson({ '@type': 'Organization', name: 'Chef Fatty' })
      + ldJson({ '@type': 'WebSite', name: 'cheffatty.com' })
      + ldJson(RECIPE)
      + ldJson({ '@type': 'BreadcrumbList', itemListElement: [] }),
    )
    expect(extractRecipeJsonLd(html)?.name).toBe('Chili Crispy Pork Noodles')
  })

  test('unwraps @graph and mainEntity nesting', () => {
    expect(
      extractRecipeJsonLd(page(ldJson({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite' }, RECIPE] })))?.name,
    ).toBe('Chili Crispy Pork Noodles')

    expect(
      extractRecipeJsonLd(page(ldJson({ '@type': 'WebPage', mainEntity: RECIPE })))?.name,
    ).toBe('Chili Crispy Pork Noodles')
  })

  test('accepts @type as an array', () => {
    // WordPress recipe plugins routinely dual-type the node.
    const html = page(ldJson({ ...RECIPE, '@type': ['Recipe', 'BlogPosting'] }))
    expect(extractRecipeJsonLd(html)?.name).toBe('Chili Crispy Pork Noodles')
  })

  test('flattens every shape recipeInstructions is published in', () => {
    const steps = (recipeInstructions: unknown) =>
      extractRecipeJsonLd(page(ldJson({ ...RECIPE, recipeInstructions })))?.instructions

    expect(steps(['Boil water.', 'Add pasta.'])).toEqual(['Boil water.', 'Add pasta.'])

    expect(steps([
      { '@type': 'HowToStep', text: 'Boil water.' },
      { '@type': 'HowToStep', text: 'Add pasta.' },
    ])).toEqual(['Boil water.', 'Add pasta.'])

    // Sections hold their own step lists, and both levels have a `name`.
    expect(steps([
      { '@type': 'HowToSection', name: 'Sauce', itemListElement: [{ '@type': 'HowToStep', text: 'Soften the onion.' }] },
      { '@type': 'HowToSection', name: 'Pasta', itemListElement: [{ '@type': 'HowToStep', text: 'Boil water.' }] },
    ])).toEqual(['Soften the onion.', 'Boil water.'])

    // One string holding every step. Newlines are a safe split; full stops are
    // not — "Heat to 180 C. approx" would shatter.
    expect(steps('Boil water.\nAdd pasta.\n\nDrain.')).toEqual(['Boil water.', 'Add pasta.', 'Drain.'])
    expect(steps('Heat the oven to 180 C. Bake for 20 minutes.'))
      .toEqual(['Heat the oven to 180 C. Bake for 20 minutes.'])
  })

  test('resolves image from a string, an array, or an ImageObject', () => {
    const photo = (image: unknown) => extractRecipeJsonLd(page(ldJson({ ...RECIPE, image })))?.photoURL

    expect(photo('https://x.test/a.jpg')).toBe('https://x.test/a.jpg')
    expect(photo(['https://x.test/a.jpg', 'https://x.test/b.jpg'])).toBe('https://x.test/a.jpg')
    expect(photo({ '@type': 'ImageObject', url: 'https://x.test/a.jpg' })).toBe('https://x.test/a.jpg')
    expect(photo([{ '@type': 'ImageObject', contentUrl: 'https://x.test/a.jpg' }])).toBe('https://x.test/a.jpg')
    expect(photo(undefined)).toBeNull()
  })

  test('splits keywords whether they arrive as a string or a list', () => {
    const keywords = (node: Record<string, unknown>) =>
      extractRecipeJsonLd(page(ldJson({ ...RECIPE, ...node })))?.keywords

    expect(keywords({ keywords: 'spicy, pork, quick' })).toEqual(['spicy', 'pork', 'quick'])
    expect(keywords({ keywords: ['spicy', 'pork'] })).toEqual(['spicy', 'pork'])
    expect(keywords({ keywords: 'spicy', recipeCuisine: 'Thai', recipeCategory: 'Main' }))
      .toEqual(['spicy', 'Main', 'Thai'])
  })

  test('accepts the pre-2017 `ingredients` spelling', () => {
    const html = page(ldJson({ '@type': 'Recipe', name: 'Old', ingredients: ['2 eggs'], recipeInstructions: ['Fry.'] }))
    expect(extractRecipeJsonLd(html)?.ingredients).toEqual(['2 eggs'])
  })

  test('strips embedded markup and entities from published text', () => {
    const html = page(ldJson({
      ...RECIPE,
      description: '<p>Glossy noodles &amp; chili crisp.</p>',
      recipeIngredient: ['<span>8 oz</span> ground pork'],
    }))
    const recipe = extractRecipeJsonLd(html)
    expect(recipe!.description).toBe('Glossy noodles & chili crisp.')
    expect(recipe!.ingredients).toEqual(['8 oz ground pork'])
  })

  test('skips a malformed block instead of failing the whole page', () => {
    // Invalid JSON-LD is common in the wild; one bad block used to be enough to
    // lose a page whose other blocks were fine.
    const html = page('<script type="application/ld+json">{ oops, not json }</script>' + ldJson(RECIPE))
    expect(extractRecipeJsonLd(html)?.name).toBe('Chili Crispy Pork Noodles')
  })

  test('skips a Recipe stub with neither ingredients nor steps', () => {
    // Category and index pages emit these for the breadcrumb alone.
    const html = page(
      ldJson({ '@type': 'Recipe', name: 'Related: Pad Thai' })
      + ldJson(RECIPE),
    )
    expect(extractRecipeJsonLd(html)?.name).toBe('Chili Crispy Pork Noodles')
  })

  test('returns null when the page publishes no recipe markup', () => {
    expect(extractRecipeJsonLd(page(ldJson({ '@type': 'WebSite', name: 'a blog' })))).toBeNull()
    expect(extractRecipeJsonLd(page(''))).toBeNull()
    expect(extractRecipeJsonLd('')).toBeNull()
  })
})

describe('extractMainContent', () => {
  const filler = (label: string, n: number) => `<p>${`${label} `.repeat(n)}</p>`

  test('ignores an empty <main> and takes the element that has the content', async () => {
    // The regression this whole path exists for. `$('main').html()` returned
    // `<!--$?--><!--/$-->` — 18 chars and truthy — so the old `||` chain stopped
    // at <main> and the page was rejected without ever reaching the model.
    const html = page('', `
      <main><template id="P:2"></template><!--$?--><template id="B:3"></template><!--/$--></main>
      <article><h1>Chili Crispy Pork Noodles</h1>${filler('ingredients and steps', 40)}</article>
    `)
    const content = extractMainContent(html)
    expect(content).not.toBeNull()
    expect(content).toContain('Chili Crispy Pork Noodles')
  })

  test('prefers <main> when <main> is the one carrying the text', () => {
    const html = page('', `
      <main><h1>Real recipe</h1>${filler('real content', 40)}</main>
      <article>${filler('related link', 3)}</article>
    `)
    expect(extractMainContent(html)).toContain('Real recipe')
  })

  test('removes scripts and styles before measuring', () => {
    // Otherwise a page whose only bulk is an inline bundle looks content-rich.
    const html = page('', `<main><style>${'.a{color:red}'.repeat(200)}</style><p>short</p></main>`)
    expect(extractMainContent(html)).toBeNull()
  })

  test('returns null for a page with no readable text', () => {
    expect(extractMainContent(page('', '<main><template id="P:1"></template><!--$?--></main>'))).toBeNull()
    expect(extractMainContent(page('', ''))).toBeNull()
  })
})
