/**
 * Pool membership and liquidity views (#677).
 *
 * The indexer already stores the raw pool state — admins, balance,
 * `threshold` — but there was no way to ask the API what a given address
 * actually has:
 *
 * 1. *Is this address a member of this pool, and what is its role?* This
 *    is derived from the admin roster, so it must stay fully in sync with the
 *    snapshot the rest of the pool view is built upon.
 * 2. *What does this pool (or the system as a whole) look like?* Provides a
 *    liquidity summary, with counts and balances.
 *
 * Everything here is **pure**: it takes a pool record (and optional parameters for
 * them) and returns a JSON-safe view. That keeps authorization checks and
 * membership rule testable without a database, and ensures that any summary
 * reports is the count of the records it processed, meaning summary counts can
 * never disagree with the rows behind it, because they are derived from them.
 *
 * Balances are `bigint` and are emitted as decimal strings. Each unit
 * is a Stellar token amount in the smallest unit (stroops), avoiding
 * `Number.MAX_SAFE_INTEGER`; coercing to `number` could truncate a large
 * balance and publish a wrong figure.
 */

import { PoolRecord } from "../../db";
import { isValidStellarAddress, normalizeStellarAddress } from "../utils/stellar"; // Adjust path if needed based on your project structure

export class PoolViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolViewError";
  }
}

/**
 * Validates whether a threshold is valid for a given admin count.
 */
export function isThresholdValid(threshold: number, adminCount: number): boolean {
  return threshold > 0 && threshold <= adminCount;
}

/**
 * Validates and normalizes a membership address string.
 */
export function validateMembershipAddress(address: unknown): string {
  if (typeof address !== "string" || !address.trim()) {
    throw new PoolViewError("Membership address must be a non-empty string.");
  }
  const trimmed = address.trim();
  // Basic validation check (can rely on isValidStellarAddress if available)
  if (!isValidStellarAddress || isValidStellarAddress(trimmed)) {
    return trimmed;
  }
  throw new PoolViewError(`Invalid Stellar address: ${trimmed}`);
}

/**
 * Determines pool membership and role for a given address.
 */
export function poolMembership(pool: PoolRecord, address: unknown) {
  const normalizedAddress = validateMembershipAddress(address).toLowerCase();
  const admins = (pool.admins || []).map((a) => a.trim().toLowerCase());
  const member = admins.includes(normalizedAddress);
  const threshold = pool.threshold ?? 1;
  const adminCount = admins.length;

  return {
    pool_id: pool.pool_id,
    member,
    role: member ? "admin" : "none",
    admin_count: adminCount,
    threshold,
  };
}

/**
 * Generates a precision-safe liquidity view for a pool.
 */
export function poolLiquidity(pool: PoolRecord) {
  const balanceBigInt = BigInt(pool.balance ?? 0n);
  const adminCount = (pool.admins || []).length;
  const threshold = pool.threshold ?? 1;

  return {
    pool_id: pool.pool_id,
    token: pool.token,
    balance: balanceBigInt.toString(),
    active: balanceBigInt > 0n,
    operational: isThresholdValid(threshold, adminCount),
    admin_count: adminCount,
    threshold,
  };
}

/**
 * Summarizes liquidity across multiple pools.
 */
export function summarizeLiquidity(pools: PoolRecord[]) {
  let totalBalance = 0n;
  let activeCount = 0;
  let inactiveCount = 0;
  const tokens = new Set<string>();
  const poolViews = pools.map((pool) => {
    const view = poolLiquidity(pool);
    totalBalance += BigInt(pool.balance ?? 0n);
    if (view.active) {
      activeCount++;
    } else {
      inactiveCount++;
    }
    if (pool.token) {
      tokens.add(pool.token);
    }
    return view;
  });

  return {
    pool_count: pools.length,
    active_pool_count: activeCount,
    inactive_pool_count: inactiveCount,
    total_balance: totalBalance.toString(),
    token_count: tokens.size,
    pools: poolViews,
  };
}

/**
 * Validates that a deposit amount string or bigint has valid decimal precision.
 * Throws a PoolViewError if precision is invalid or negative.
 */
export function validateDepositPrecision(amount: string | bigint): bigint {
  const strAmount = amount.toString().trim();
  
  if (!/^\d+(\.\d{1,7})?$/.test(strAmount) && !/^\d+$/.test(strAmount)) {
    throw new PoolViewError("Invalid deposit precision: amounts can have at most 7 decimal places.");
  }

  if (strAmount.includes(".")) {
    const [whole, decimal] = strAmount.split(".");
    const paddedDecimal = decimal.padEnd(7, "0");
    return BigInt(whole) * 10_000_000n + BigInt(paddedDecimal);
  }

  return BigInt(strAmount);
}
