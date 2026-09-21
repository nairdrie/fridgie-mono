/** Firebase Auth UIDs stored as single Firestore document IDs. */
export function isValidUserId(value: string | undefined): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && value.trim().length > 0
    && value !== '.'
    && value !== '..'
    && !/^__.*__$/.test(value)
    && !/[\/\u0000-\u001f\u007f]/.test(value);
}
