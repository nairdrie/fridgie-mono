import { describe, expect, test } from 'bun:test'
import {
  convertTemperature,
  findStepTemperatures,
  formatTemperature,
  splitStepTemperatures,
  type Temperature,
} from '@fridgie/shared/cookTemperatures'

/** Compact view of what a step yields: "value unit" per temperature. */
const temps = (step: string) =>
  findStepTemperatures(step).map((t) => `${t.value}${t.unit}`)

describe('findStepTemperatures', () => {
  test('reads the wordings recipe steps actually use', () => {
    expect(temps('Preheat oven to 400°F.')).toEqual(['400F'])
    expect(temps('Bake at 180°C.')).toEqual(['180C'])
    expect(temps('Heat to 350 degrees F.')).toEqual(['350F'])
    expect(temps('Roast at 220 degrees Celsius.')).toEqual(['220C'])
    expect(temps('Set the oven to 425F.')).toEqual(['425F'])
    expect(temps('Bring to 180 C before adding.')).toEqual(['180C'])
    expect(temps('Preheat to 375 °F.')).toEqual(['375F'])
    expect(temps('Cook to 165°F internal.')).toEqual(['165F'])
  })

  test('the user-typed lowercase "400f" is a temperature', () => {
    expect(temps('preheat to 400f')).toEqual(['400F'])
    expect(temps('bake at 180c')).toEqual(['180C'])
  })

  test('handles the precomposed degree glyphs', () => {
    expect(temps('Preheat to 400℉.')).toEqual(['400F'])
    expect(temps('Preheat to 200℃.')).toEqual(['200C'])
  })

  test('finds several temperatures in one step, in order', () => {
    expect(temps('Sear at 500°F, then reduce to 350°F.')).toEqual(['500F', '350F'])
    expect(temps('165°F (74°C)')).toEqual(['165F', '74C'])
  })

  test('infers Fahrenheit for a bare high degree marker', () => {
    // No scale written, but 400°C is not a home oven — so it can only be F.
    expect(temps('Preheat oven to 400°.')).toEqual(['400F'])
    expect(temps('Bake at 425 degrees.')).toEqual(['425F'])
    expect(findStepTemperatures('Preheat oven to 400°.')[0]?.inferred).toBe(true)
  })

  test('leaves an ambiguous bare degree alone', () => {
    // 180° could be a hot Fahrenheit or a moderate Celsius oven. Without a
    // scale, guessing is worse than not offering the button.
    expect(temps('Warm to 180°.')).toEqual([])
    expect(temps('Hold at 200 degrees.')).toEqual([])
  })

  test('an explicit scale is honoured even when low', () => {
    expect(temps('Proof at 100°F.')).toEqual(['100F'])
    expect(temps('Chill the bowl to 40°F.')).toEqual([]) // below the F range
    expect(temps('Melt at 45°C.')).toEqual(['45C'])
  })

  test('a number without a temperature marker is never a temperature', () => {
    // The whole point: these are the false positives to avoid.
    expect(temps('Cut into 2 inch pieces.')).toEqual([])
    expect(temps('Use a 9 inch tin.')).toEqual([])
    expect(temps('Add 350 g of flour.')).toEqual([])
    expect(temps('Preheat the oven to 400.')).toEqual([]) // no degree, no scale
    expect(temps('Bake for 20 minutes.')).toEqual([])
    expect(temps('Makes 12 muffins.')).toEqual([])
  })

  test('a scale letter never eats into a neighbouring word', () => {
    expect(temps('Stir in 100 cc of cream.')).toEqual([]) // not "100 c"
    expect(temps('Fold in 350 cloves? never.')).toEqual([]) // not "350 c"
    expect(temps('Bake 400 Fresh loaves.')).toEqual([]) // not "400 F"
  })

  test('rejects readings that are out of any cooking range', () => {
    expect(temps('Turn dial to 900°F.')).toEqual([]) // 3 digits but off the top
    expect(temps('At 350 Celsius, absurd.')).toEqual([]) // 350°C is not a home oven
    expect(temps('Room at 12°C is fine.')).toEqual([]) // 12°C is not a cooking temp
  })

  test('survives junk input', () => {
    expect(findStepTemperatures('')).toEqual([])
    expect(findStepTemperatures(undefined as unknown as string)).toEqual([])
    expect(findStepTemperatures(null as unknown as string)).toEqual([])
  })

  test('is not stateful across calls', () => {
    // The regex is module-level and /g, so a leaked lastIndex would make the
    // second identical call return nothing.
    expect(temps('Preheat oven to 400°F.')).toEqual(['400F'])
    expect(temps('Preheat oven to 400°F.')).toEqual(['400F'])
  })
})

describe('splitStepTemperatures', () => {
  test('rebuilds the step exactly from its segments', () => {
    const step = 'Sear at 500°F, then bake at 180°C for a bit.'
    const joined = splitStepTemperatures(step)
      .map((s) => s.text)
      .join('')
    expect(joined).toBe(step)
  })

  test('marks only the temperatures, keeping the prose between them', () => {
    const segments = splitStepTemperatures('Preheat to 400°F now.')
    expect(segments.map((s) => s.text)).toEqual(['Preheat to ', '400°F', ' now.'])
    expect(segments.map((s) => !!s.temp)).toEqual([false, true, false])
  })

  test('a step with no temperature is a single prose segment', () => {
    expect(splitStepTemperatures('Whisk the eggs.')).toEqual([{ text: 'Whisk the eggs.' }])
  })

  test('folds an unplaceable near-match back into the prose', () => {
    // "180°" is left ambiguous, so it stays plain text — not its own segment.
    expect(splitStepTemperatures('Warm to 180°.')).toEqual([{ text: 'Warm to 180°.' }])
  })
})

describe('convertTemperature', () => {
  const f = (value: number): Temperature => ({ raw: `${value}F`, value, unit: 'F', inferred: false })
  const c = (value: number): Temperature => ({ raw: `${value}C`, value, unit: 'C', inferred: false })

  test('converts F to C, rounded to oven-chart fives', () => {
    expect(convertTemperature(f(400))).toMatchObject({ value: 205, unit: 'C' })
    expect(convertTemperature(f(350))).toMatchObject({ value: 175, unit: 'C' })
    expect(convertTemperature(f(212))).toMatchObject({ value: 100, unit: 'C' })
  })

  test('converts C to F, rounded to oven-chart fives', () => {
    expect(convertTemperature(c(180))).toMatchObject({ value: 355, unit: 'F' })
    expect(convertTemperature(c(200))).toMatchObject({ value: 390, unit: 'F' })
    expect(convertTemperature(c(100))).toMatchObject({ value: 210, unit: 'F' })
  })

  test('round-trips through the app by keeping the original exact', () => {
    // The UI holds the original and only ever converts it fresh, so toggling
    // back is the untouched reading rather than a doubly-rounded one.
    const original = f(425)
    expect(convertTemperature(original)).toMatchObject({ value: 220, unit: 'C' })
    expect(original.value).toBe(425)
  })
})

describe('formatTemperature', () => {
  test('reads as a cook would write it', () => {
    expect(formatTemperature({ raw: '', value: 400, unit: 'F', inferred: false })).toBe('400°F')
    expect(formatTemperature({ raw: '', value: 205, unit: 'C', inferred: false })).toBe('205°C')
  })

  test('normalises a wordy original to the clean form', () => {
    const [temp] = findStepTemperatures('Heat to 350 degrees F.')
    expect(temp && formatTemperature(temp)).toBe('350°F')
  })
})
