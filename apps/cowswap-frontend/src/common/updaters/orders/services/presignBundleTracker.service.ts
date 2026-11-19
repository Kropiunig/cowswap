import { UnknownBundleIdError } from 'viem'
import { Config } from 'wagmi'
import { getCallsStatus } from 'wagmi/actions'

import { normalizeError } from '@cowprotocol/common-utils'
import { SupportedChainId as ChainId } from '@cowprotocol/cow-sdk'

import ms from 'ms.macro'

import { Order, OrderStatus } from 'legacy/state/orders/actions'
import { InvalidateOrdersBatchCallback } from 'legacy/state/orders/hooks'

// Wallets index a fresh EIP-5792 bundle asynchronously and may be slow or unreachable for a while, so a
// failed status check is retried on the next poll. A bundle that stays unreadable for this long is treated
// as lost; a wrong call heals itself because OrdersFromApiUpdater restores the order once the order book
// reports it presigned.
export const PRESIGN_BUNDLE_STATUS_ERROR_TIMEOUT = ms`5m`

export type UpdatePresignBundleOrders = (params: UpdatePresignBundleOrdersParams) => Promise<void>

export interface UpdatePresignBundleOrdersParams {
  chainId: ChainId
  orders: Order[]
  isSafeWallet: boolean
  invalidateOrdersBatch: InvalidateOrdersBatchCallback
}

type PresignBundleOrder = Order & { presignBundleId: string }

enum BundleCheckResult {
  Alive,
  Failed,
  Unavailable,
}

/**
 * Tracks approve + presign batches sent through EIP-5792 by wallets that are not a Safe (EIP-7702 EOAs,
 * smart accounts). The order book moves a pending bundle's order to PENDING by itself once the presignature
 * is indexed; this only fails orders whose bundle the wallet reports as failed or unknown.
 */
export function createPresignBundleTracker(config: Config): UpdatePresignBundleOrders {
  const unavailableSince = new Map<string, number>()

  return async ({ chainId, orders, isSafeWallet, invalidateOrdersBatch }) => {
    const bundleOrders = orders.filter(isPendingBundleOrder)
    const trackedIds = new Set(bundleOrders.map(({ id }) => id))

    Array.from(unavailableSince.keys())
      .filter((id) => !trackedIds.has(id))
      .forEach((id) => unavailableSince.delete(id))

    const failedIds: string[] = []

    await Promise.all(
      bundleOrders.map(async (order) => {
        const result = await checkBundle(config, order.presignBundleId)

        if (result === BundleCheckResult.Alive) {
          unavailableSince.delete(order.id)
          return
        }

        if (result === BundleCheckResult.Unavailable) {
          const now = Date.now()
          const since = unavailableSince.get(order.id) ?? now

          if (now - since < PRESIGN_BUNDLE_STATUS_ERROR_TIMEOUT) {
            unavailableSince.set(order.id, since)
            return
          }
        }

        unavailableSince.delete(order.id)
        failedIds.push(order.id)
        console.warn('[PendingOrdersUpdater] Presign bundle is lost, failing order:', order.id, order.presignBundleId)
      }),
    )

    if (failedIds.length) {
      invalidateOrdersBatch({ ids: failedIds, chainId, isSafeWallet })
    }
  }
}

async function checkBundle(config: Config, bundleId: string): Promise<BundleCheckResult> {
  try {
    const { status, statusCode } = await getCallsStatus(config, { id: bundleId })

    if (status === 'pending' || status === 'success') return BundleCheckResult.Alive

    if (status === 'failure') {
      console.warn('[PendingOrdersUpdater] Presign bundle failed:', bundleId, statusCode)
      return BundleCheckResult.Failed
    }

    console.debug('[PendingOrdersUpdater] Presign bundle status not recognised:', bundleId, statusCode)
    return BundleCheckResult.Unavailable
  } catch (err: unknown) {
    const error = normalizeError(err)

    if (error.code === UnknownBundleIdError.code) return BundleCheckResult.Failed

    console.debug('[PendingOrdersUpdater] Failed to fetch presign bundle status:', bundleId, error)
    return BundleCheckResult.Unavailable
  }
}

function isPendingBundleOrder(order: Order): order is PresignBundleOrder {
  return !!order.presignBundleId && order.status === OrderStatus.PRESIGNATURE_PENDING
}
