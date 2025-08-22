export function toE164(raw: string) {
    // Remove everything but digits
    const digits = raw.replace(/\D+/g, '');
    
    // If it already starts with your country code, fine; otherwise prepend it
    const withCC = digits.startsWith('1') ? digits : '1' + digits;
    
    return '+' + withCC;
}