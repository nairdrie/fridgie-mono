export function toE164(raw: string) {
    // Remove everything but digits
    const digits = raw.replace(/\D+/g, '');
    
    // If it already starts with your country code, fine; otherwise prepend it
    const withCC = digits.startsWith('1') ? digits : '1' + digits;
    
    return '+' + withCC;
}

export function toReadablePhone(raw: string) {
    // First, normalize the input to the E.164 format (e.g., +14165551234)
    const e164 = toE164(raw);

    // Use a regex to capture the parts and reformat the string.
    // It captures the country code (+1), area code (3 digits),
    // prefix (3 digits), and line number (4 digits).
    // If the regex doesn't match (e.g., for an incomplete number),
    // it returns the e164 string as a fallback.
    return e164.replace(
        /^(\+\d)(\d{3})(\d{3})(\d{4})$/, 
        '$1 ($2)-$3-$4'
    );
}