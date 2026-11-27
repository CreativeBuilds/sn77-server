import { encodeAddress, signatureVerify } from '@polkadot/util-crypto';
import { verifyMessage } from 'ethers';

export const verifySignature = (
    message: string,
    signature: string,
    address: string,
): { success: boolean; error: string | null } => {
    try {
        // Single verification path. signatureVerify handles 64-byte signatures, 65-byte
        // type-prefixed (MultiSignature) signatures and <Bytes>-wrapped payloads from wallet
        // extensions. isValid MUST be checked: the returned publicKey is derived from the
        // address argument, so comparing it to the address proves nothing on its own.
        const { isValid, publicKey } = signatureVerify(message, signature, address);
        if (isValid !== true) return { success: false, error: 'Invalid signature' };
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