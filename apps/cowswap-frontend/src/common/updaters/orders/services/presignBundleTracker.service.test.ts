import { UnknownBundleIdError } from 'viem'
import { getCallsStatus } from 'wagmi/actions'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import ms from 'ms.macro'

import { Order, OrderStatus } from 'legacy/state/orders/actions'

import {
  createPresignBundleTracker,
  PRESIGN_BUNDLE_STATUS_ERROR_TIMEOUT,
  UpdatePresignBundleOrders,
} from './presignBundleTracker.service'

jest.mock('wagmi/actions', () => ({
  getCallsStatus: jest.fn(),
}))

const getCallsStatusMock = getCallsStatus as jest.MockedFunction<typeof getCallsStatus>

const CHAIN_ID = SupportedChainId.MAINNET
const CONFIG = { chains: [] } as never
const BUNDLE_ID = '0xbundle'
const START = new Date('2026-01-01T00:00:00Z').getTime()
const POLL_INTERVAL = ms`15s`

function buildOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: '0xorder',
    status: OrderStatus.PRESIGNATURE_PENDING,
    presignBundleId: BUNDLE_ID,
    ...overrides,
  } as Order
}

function mockRejection(error: unknown): void {
  getCallsStatusMock.mockRejectedValueOnce(error)
}

function mockStatus(status: 'pending' | 'success' | 'failure' | undefined, statusCode: number): void {
  getCallsStatusMock.mockResolvedValueOnce({ status, statusCode } as never)
}

describe('createPresignBundleTracker', () => {
  const invalidateOrdersBatch = jest.fn()
  const isSafeWallet = false

  let update: UpdatePresignBundleOrders

  function run(orders: Order[] = [buildOrder()]): Promise<void> {
    return update({ chainId: CHAIN_ID, orders, isSafeWallet, invalidateOrdersBatch })
  }

  // Polls every POLL_INTERVAL while the wallet keeps failing, for `duration` in total
  async function runFailingFor(duration: number, orders?: Order[]): Promise<void> {
    const end = Date.now() + duration

    while (Date.now() <= end) {
      mockRejection(new Error('wallet unreachable'))
      await run(orders)
      jest.advanceTimersByTime(POLL_INTERVAL)
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers({ now: START })
    update = createPresignBundleTracker(CONFIG)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('polls only PRESIGNATURE_PENDING orders that carry a bundle id', async () => {
    await run([
      buildOrder({ id: '0xsafe', presignBundleId: undefined, presignGnosisSafeTxHash: '0xsafetxhash' }),
      buildOrder({ id: '0xopen', status: OrderStatus.PENDING }),
    ])

    expect(getCallsStatusMock).not.toHaveBeenCalled()
    expect(invalidateOrdersBatch).not.toHaveBeenCalled()
  })

  it('asks the wallet for the status of the stored bundle id', async () => {
    mockStatus('pending', 100)

    await run()

    expect(getCallsStatusMock).toHaveBeenCalledWith(CONFIG, { id: BUNDLE_ID })
  })

  it('keeps a pending bundle waiting', async () => {
    mockStatus('pending', 100)

    await run()

    expect(invalidateOrdersBatch).not.toHaveBeenCalled()
  })

  it('leaves a confirmed bundle to the order book poll', async () => {
    mockStatus('success', 200)

    await run()

    expect(invalidateOrdersBatch).not.toHaveBeenCalled()
  })

  it('invalidates the order when the bundle failed', async () => {
    mockStatus('failure', 500)

    await run()

    expect(invalidateOrdersBatch).toHaveBeenCalledTimes(1)
    expect(invalidateOrdersBatch).toHaveBeenCalledWith({ ids: ['0xorder'], chainId: CHAIN_ID, isSafeWallet })
  })

  it('invalidates the order when the wallet does not know the bundle (EIP-5792 error 5730)', async () => {
    mockRejection(new UnknownBundleIdError(new Error('unknown bundle')))

    await run()

    expect(invalidateOrdersBatch).toHaveBeenCalledWith({ ids: ['0xorder'], chainId: CHAIN_ID, isSafeWallet })
  })

  it('keeps retrying while transient errors have lasted less than the timeout', async () => {
    await runFailingFor(PRESIGN_BUNDLE_STATUS_ERROR_TIMEOUT - POLL_INTERVAL)

    expect(getCallsStatusMock.mock.calls.length).toBeGreaterThan(1)
    expect(invalidateOrdersBatch).not.toHaveBeenCalled()
  })

  it('invalidates the order once transient errors have lasted for the timeout', async () => {
    await runFailingFor(PRESIGN_BUNDLE_STATUS_ERROR_TIMEOUT)

    expect(invalidateOrdersBatch).toHaveBeenCalledTimes(1)
    expect(invalidateOrdersBatch).toHaveBeenCalledWith({ ids: ['0xorder'], chainId: CHAIN_ID, isSafeWallet })
  })

  it('does not invalidate on the first error, however old the order is', async () => {
    jest.setSystemTime(START + PRESIGN_BUNDLE_STATUS_ERROR_TIMEOUT * 10)
    mockRejection(new Error('wallet unreachable'))

    await run()

    expect(invalidateOrdersBatch).not.toHaveBeenCalled()
  })

  it('restarts the timeout after a readable status', async () => {
    await runFailingFor(PRESIGN_BUNDLE_STATUS_ERROR_TIMEOUT - POLL_INTERVAL)
    mockStatus('pending', 100)
    await run()
    jest.advanceTimersByTime(POLL_INTERVAL)
    await runFailingFor(PRESIGN_BUNDLE_STATUS_ERROR_TIMEOUT - POLL_INTERVAL)

    expect(invalidateOrdersBatch).not.toHaveBeenCalled()
  })

  it('treats an unrecognised status code as a transient error', async () => {
    mockStatus(undefined, 999)
    await run()
    jest.advanceTimersByTime(PRESIGN_BUNDLE_STATUS_ERROR_TIMEOUT)
    mockStatus(undefined, 999)
    await run()

    expect(invalidateOrdersBatch).toHaveBeenCalledTimes(1)
  })

  it('tracks the timeout per order', async () => {
    const failing = buildOrder({ id: '0xfailing', presignBundleId: '0xfailingbundle' })
    const healthy = buildOrder({ id: '0xhealthy', presignBundleId: '0xhealthybundle' })

    getCallsStatusMock.mockImplementation(async (_config, { id }) => {
      if (id === '0xfailingbundle') throw new Error('wallet unreachable')

      return { status: 'pending', statusCode: 100 } as never
    })

    await run([failing, healthy])
    jest.advanceTimersByTime(PRESIGN_BUNDLE_STATUS_ERROR_TIMEOUT)
    await run([failing, healthy])

    expect(invalidateOrdersBatch).toHaveBeenCalledTimes(1)
    expect(invalidateOrdersBatch).toHaveBeenCalledWith({ ids: ['0xfailing'], chainId: CHAIN_ID, isSafeWallet })
  })

  it('forgets the timeout of an order that is no longer tracked', async () => {
    mockRejection(new Error('wallet unreachable'))
    await run()
    await run([buildOrder({ status: OrderStatus.PENDING })])
    jest.advanceTimersByTime(PRESIGN_BUNDLE_STATUS_ERROR_TIMEOUT)
    mockRejection(new Error('wallet unreachable'))
    await run()

    expect(invalidateOrdersBatch).not.toHaveBeenCalled()
  })
})
