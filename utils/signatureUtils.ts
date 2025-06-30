import { encodeAddress, signatureVerify } from '@polkadot/util-crypto';
import { verifyMessage } from 'ethers';

export const verifySignature = (
    message: string,
    signature: string,
    address: string,
): { success: boolean; error: string | null } => {
    try {
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