import { describe, expect, test } from 'bun:test'
import { SECTIONS, SECTION_OVERRIDES, overrideSection } from '../utils/aisles'

describe('overrideSection', () => {
  test('files hummus with the deli, however it is written', () => {
    expect(overrideSection('hummus')).toBe('Deli')
    expect(overrideSection('Hummus')).toBe('Deli')
    expect(overrideSection('roasted red pepper hummus')).toBe('Deli')
    expect(overrideSection('2 tubs of hummus')).toBe('Deli')
    expect(overrideSection('tzatziki')).toBe('Deli')
  })

  test('files flatbreads with the bread, however they are written', () => {
    expect(overrideSection('tortillas')).toBe('Bakery')
    expect(overrideSection('flour tortillas')).toBe('Bakery')
    expect(overrideSection('8 whole wheat tortillas (soft)')).toBe('Bakery')
    expect(overrideSection('pita bread')).toBe('Bakery')
    expect(overrideSection('naan')).toBe('Bakery')
  })

  test('leaves the snack made FROM one alone', () => {
    // The trap in matching anywhere in the string rather than at the end:
    // tortilla chips are Snacks & Candy, and the model already knows that.
    expect(overrideSection('tortilla chips')).toBeNull()
    expect(overrideSection('a bag of pita chips')).toBeNull()
  })

  test('has nothing to say about anything else', () => {
    expect(overrideSection('milk')).toBeNull()
    expect(overrideSection('2 lbs chicken breast')).toBeNull()
    expect(overrideSection('')).toBeNull()
    expect(overrideSection('   ')).toBeNull()
  })
})

describe('SECTION_OVERRIDES', () => {
  test('only names aisles that exist', () => {
    // The model's answers are held to the SECTIONS enum by the schema; these
    // bypass the model entirely, so nothing else holds them to it.
    for (const section of Object.values(SECTION_OVERRIDES)) {
      expect(SECTIONS).toContain(section)
    }
  })

  test('survives canonicalization — every entry is still reachable', () => {
    // An entry whose wording canonicalizes to something no item ever produces
    // is dead weight that reads as a fix. Ask each one about itself.
    for (const [phrase, section] of Object.entries(SECTION_OVERRIDES)) {
      expect(overrideSection(phrase)).toBe(section)
    }
  })
})
