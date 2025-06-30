import { ethers } from 'ethers';
import { normalizeWeights } from './validationUtils';

const MAX_POOLS = 10;
const TOTAL_WEIGHT = 10000;

export interface Pool {
  address: string;
  weight: number;
  token0?: string;
  token1?: string;
  token0Symbol?: string;
  token1Symbol?: string;
}

export const searchPools = async (query: string): Promise<[Pool[], string | null]> => {
  try {
    // TODO: Implement actual pool search logic
    // For now, return mock data
    return [[{
      address: '0x1234567890123456789012345678901234567890',
      weight: 0,
      token0: '0x1111111111111111111111111111111111111111',
      token1: '0x2222222222222222222222222222222222222222',
      token0Symbol: 'TOKEN0',
      token1Symbol: 'TOKEN1'
    }], null];
  } catch (error) {
    return [[], `Failed to search pools: ${error}`];
  }
};

export const formatAddress = (address: string): string => {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

export const normalizePoolWeights = (pools: Pool[]): [Pool[], string | null] => {
  if (pools.length === 0) return [[], 'No pools provided'];
  if (pools.length > MAX_POOLS) return [[], `Maximum ${MAX_POOLS} pools allowed`];

  const [normalizedPools, err] = normalizeWeights(pools);
  if (err) return [[], err];

  // Scale weights to sum to TOTAL_WEIGHT
  const scaledPools = normalizedPools.map(pool => ({
    ...pool,
    weight: Math.round(pool.weight * TOTAL_WEIGHT)
  }));

  return [scaledPools, null];
};

export const validatePoolAddress = (address: string): boolean => {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}; 