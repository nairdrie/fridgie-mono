import { describe, expect, test } from 'bun:test'
import { findStepTimers, formatCountdown, formatDuration } from '@fridgie/shared/cookTimers'

const seconds = (step: string) => findStepTimers(step).map((t) => t.seconds)

describe('findStepTimers', () => {
  test('reads the wordings recipe steps actually use', () => {
    expect(seconds('Simmer for 20 minutes.')).toEqual([1200])
    expect(seconds('Bake 25 mins')).toEqual([1500])
    expect(seconds('Rest for 10 min before slicing.')).toEqual([600])
    expect(seconds('Prove for 1 hour.')).toEqual([3600])
    expect(seconds('Chill for 2 hrs.')).toEqual([7200])
    expect(seconds('Blanch for 90 seconds.')).toEqual([90])
  })

  test('a range takes its LOW end — the cook wants to look early', () => {
    expect(seconds('Bake for 20-25 minutes.')).toEqual([1200])
    expect(seconds('Fry for 3 to 4 minutes.')).toEqual([180])
    expect(seconds('Simmer 45 or 50 minutes')).toEqual([2700])
  })

  test('handles fractions and mixed numbers', () => {
    expect(seconds('Rest for 1.5 hours.')).toEqual([5400])
    expect(seconds('Bake for 1 1/2 hours.')).toEqual([5400])
    expect(seconds('Chill for ½ hour.')).toEqual([1800])
  })

  test('finds several timers in one step, in order', () => {
    expect(seconds('Bake 20 minutes, then rest 10 minutes.')).toEqual([1200, 600])
  })

  test('the same duration twice is one timer', () => {
    expect(seconds('Simmer 20 minutes, stirring every 20 minutes.')).toEqual([1200])
  })

  test('a number without a time unit is never a duration', () => {
    // The failure this prevents: a timer chip on "cut into 2 inch pieces",
    // offered at the exact moment the cook has their hands full.
    expect(seconds('Cut into 2 inch pieces.')).toEqual([])
    expect(seconds('Preheat the oven to 400.')).toEqual([])
    expect(seconds('Heat to 350 degrees F.')).toEqual([])
    expect(seconds('Use a 9 inch tin.')).toEqual([])
    expect(seconds('Add 2 cups of flour.')).toEqual([])
  })

  test('an unmeasured wait is not given an invented number', () => {
    expect(seconds('Cook for a few minutes.')).toEqual([])
    expect(seconds('Simmer until reduced.')).toEqual([])
  })

  test('rejects durations that are not kitchen timers', () => {
    expect(seconds('Season for 5 seconds.')).toEqual([])      // too short to time
    expect(seconds('Leave overnight, about 12 hours.')).toEqual([])  // not a timer
  })

  test('survives junk input', () => {
    expect(findStepTimers('')).toEqual([])
    expect(findStepTimers(undefined as unknown as string)).toEqual([])
    expect(findStepTimers(null as unknown as string)).toEqual([])
  })

  test('is not stateful across calls', () => {
    // The regex is module-level and /g, so a leaked lastIndex would make the
    // second identical call return nothing.
    expect(seconds('Simmer for 20 minutes.')).toEqual([1200])
    expect(seconds('Simmer for 20 minutes.')).toEqual([1200])
  })
})

describe('formatDuration', () => {
  test('reads the way a cook would say it', () => {
    expect(formatDuration(45)).toBe('45 sec')
    expect(formatDuration(600)).toBe('10 min')
    expect(formatDuration(3600)).toBe('1 hr')
    expect(formatDuration(5400)).toBe('1 hr 30 min')
  })
})

describe('formatCountdown', () => {
  test('counts down in clock form', () => {
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(9)).toBe('0:09')
    expect(formatCountdown(247)).toBe('4:07')
    expect(formatCountdown(3750)).toBe('1:02:30')
  })

  test('never shows a negative', () => {
    expect(formatCountdown(-5)).toBe('0:00')
  })
})
