import { describe, expect, test } from 'bun:test'
import { replayStep } from './listHistory'

const item = (id: string, extra: Record<string, any> = {}): any =>
  ({ id, text: id, checked: false, listOrder: id, isSection: false, ...extra })
const ids = (rows: any[]) => rows.map(r => r.id).sort()

describe('replayStep', () => {
  test('undoing a delete brings the row back', () => {
    const before = [item('milk'), item('eggs')]
    const after = [item('eggs')]
    expect(ids(replayStep(after, before, after))).toEqual(['eggs', 'milk'])
  })

  test('undoing an add takes the row away, even after it was filed', () => {
    const before = [item('eggs')]
    const after = [item('eggs'), item('milk')]
    const now = [item('eggs'), item('milk', { section: 'Dairy' })]
    expect(ids(replayStep(after, before, now))).toEqual(['eggs'])
  })

  test('undoing a check leaves a housemate\'s later edit alone', () => {
    const before = [item('milk'), item('eggs')]
    const after = [item('milk', { checked: true }), item('eggs')]
    const now = [item('milk', { checked: true }), item('eggs', { quantity: '12' }), item('bread')]
    const undone = replayStep(after, before, now)
    expect(undone.find(r => r.id === 'milk')!.checked).toBe(false)
    expect(undone.find(r => r.id === 'eggs')!.quantity).toBe('12')
    expect(ids(undone)).toEqual(['bread', 'eggs', 'milk'])
  })

  test('redo is the same step the other way', () => {
    const before = [item('milk')]
    const after = [item('milk', { checked: true })]
    const undone = replayStep(after, before, after)
    expect(replayStep(before, after, undone)[0].checked).toBe(true)
  })
})
