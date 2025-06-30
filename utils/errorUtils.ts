export const sanitizeError = (internalError: string, genericMessage: string = 'Request failed'): string => {
    console.error('Internal error:', internalError);
    return genericMessage;
}; 