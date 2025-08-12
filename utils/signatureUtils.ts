import { encodeAddress, signatureVerify } from '@polkadot/util-crypto';
import { verifyMessage } from 'ethers';
import { stringToU8a, hexToU8a } from '@polkadot/util';

export const verifySignature = (
    message: string,
    signature: string,
    address: string,
): { success: boolean; error: string | null } => {
    try {
        // Check if this is a raw bytes signature (starts with 0x01)
        if (signature.startsWith('0x01')) {
            // For raw bytes signatures from wallet extensions, we need to verify differently
            // The signature format is: 0x01 + 01 + actual signature bytes (130 hex chars total)
            // We need to remove both the 0x01 prefix and the type indicator byte
            const signatureBytes = signature.slice(4); // Remove 0x01 prefix and type indicator
            
            // Check if the signature length is correct (should be 128 hex chars = 64 bytes)
            if (signatureBytes.length !== 128) {
                return { success: false, error: 'Invalid signature format' };
            }
            
            // Use public key recovery verification (the working method from frontend)
            try {
                const messageBytes = stringToU8a(message);
                const signatureU8a = hexToU8a(signatureBytes);
                
                // Try to get the public key from the signature
                const { publicKey: recoveredPublicKey } = signatureVerify(messageBytes, signatureU8a, address);
                
                if (recoveredPublicKey) {
                    const recoveredAddress = encodeAddress(recoveredPublicKey, 42);
                    if (recoveredAddress === address) {
                        return { success: true, error: null };
                    } else {
                        return { success: false, error: 'Address mismatch in signature' };
                    }
                } else {
                    return { success: false, error: 'Could not recover public key from signature' };
                }
            } catch (recoveryError: any) {
                return { success: false, error: `Verification error: ${recoveryError.message}` };
            }
        }
        
        // Standard verification for non-raw bytes signatures
        const { isValid, publicKey } = signatureVerify(message, signature, address);
        if (!isValid) return { success: false, error: 'Invalid signature' };
        const recoveredAddress = encodeAddress(publicKey, 42);
        if (recoveredAddress !== address) return { success: false, error: 'Invalid signature' };
        return { success: true, error: null };
    } catch (e: any) {
        console.error('Signature verification error:', e);
        return { success: false, error: 'Invalid signature' };
    }
};

export const verifyEthereumSignature = (
    message: string,
    signature: string,
    address: string,
): { success: boolean; error: string | null } => {
    try {
        const recoveredAddress = verifyMessage(message, signature);
        if (recoveredAddress.toLowerCase() !== address.toLowerCase()) return { success: false, error: 'Invalid signature' };
        return { success: true, error: null };
    } catch (e: any) {
        console.error('Ethereum signature verification error:', e);
        return { success: false, error: 'Invalid signature' };
    }
}; 