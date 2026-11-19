import { createStore, Provider } from 'jotai'
import { createElement, ReactNode } from 'react'

import { Currency } from '@cowprotocol/currency'
import { CowHookDetails } from '@cowprotocol/hook-dapp-lib'
import { PermitHookData } from '@cowprotocol/permit-utils'

import { render } from '@testing-library/react'
import { useHooksStateWithSimulatedGas } from 'entities/orderHooks/useHooksStateWithSimulatedGas'

import { useAccountAgnosticPermitHookData } from 'modules/permit'
import { useDerivedTradeState, useHasTradeEnoughAllowance, useIsHooksTradeType, useIsSellNative } from 'modules/trade'

import { AppDataHooksUpdater } from './AppDataHooksUpdater'

import { appDataHooksAtom } from '../state/atoms'

jest.mock('@cowprotocol/wallet', () => {
  const { atom } = jest.requireActual('jotai')

  return { isSafeAppAtom: atom(false), isSmartContractWalletAtom: atom(false) }
})

jest.mock('entities/orderHooks/useHooksStateWithSimulatedGas', () => ({
  useHooksStateWithSimulatedGas: jest.fn(),
}))

jest.mock('modules/permit', () => ({
  useAccountAgnosticPermitHookData: jest.fn(),
}))

jest.mock('modules/trade', () => ({
  useDerivedTradeState: jest.fn(),
  useHasTradeEnoughAllowance: jest.fn(),
  useIsHooksTradeType: jest.fn(),
  useIsSellNative: jest.fn(),
}))

const mockUseHooksStateWithSimulatedGas = jest.mocked(useHooksStateWithSimulatedGas)
const mockUseAccountAgnosticPermitHookData = jest.mocked(useAccountAgnosticPermitHookData)
const mockUseDerivedTradeState = jest.mocked(useDerivedTradeState)
const mockUseHasTradeEnoughAllowance = jest.mocked(useHasTradeEnoughAllowance)
const mockUseIsHooksTradeType = jest.mocked(useIsHooksTradeType)
const mockUseIsSellNative = jest.mocked(useIsSellNative)

const SELL_TOKEN_A = { chainId: 1, isNative: false, address: '0x1111111111111111111111111111111111111111' }
const SELL_TOKEN_B = { chainId: 1, isNative: false, address: '0x2222222222222222222222222222222222222222' }
const POST_HOOK_TARGET = '0x3333333333333333333333333333333333333333'
const PERMIT_TARGET = '0x4444444444444444444444444444444444444444'

const POST_HOOK: CowHookDetails = {
  uuid: 'post-hook',
  hook: { target: POST_HOOK_TARGET, callData: '0x', gasLimit: '21000', dappId: 'BUILD_CUSTOM_HOOK' },
}
const PERMIT: PermitHookData = { target: PERMIT_TARGET, callData: '0xd505accf', gasLimit: '80000' }

// useHooksStateWithSimulatedGas memoizes its arrays, so they keep their identity while the hooks do not change
const NO_HOOKS: CowHookDetails[] = []
const ONE_POST_HOOK: CowHookDetails[] = [POST_HOOK]

interface SetupParams {
  sellToken: typeof SELL_TOKEN_A
  postHooks?: CowHookDetails[]
  hasAllowance?: boolean
  /** undefined means the permit data for the sell token has not loaded yet */
  permit?: PermitHookData
}

function applyMocks({ sellToken, postHooks = NO_HOOKS, hasAllowance = true, permit }: SetupParams): void {
  mockUseDerivedTradeState.mockReturnValue({
    inputCurrency: sellToken as unknown as Currency,
  } as ReturnType<typeof useDerivedTradeState>)
  mockUseIsHooksTradeType.mockReturnValue(true)
  mockUseIsSellNative.mockReturnValue(false)
  mockUseHooksStateWithSimulatedGas.mockReturnValue({ preHooks: NO_HOOKS, postHooks })
  mockUseHasTradeEnoughAllowance.mockReturnValue(hasAllowance)
  mockUseAccountAgnosticPermitHookData.mockReturnValue(permit)
}

function renderUpdater(params: SetupParams): {
  store: ReturnType<typeof createStore>
  rerenderWith(next: SetupParams): void
} {
  const store = createStore()
  applyMocks(params)

  function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return createElement(Provider, { store }, children)
  }

  const { rerender } = render(createElement(AppDataHooksUpdater), { wrapper: Wrapper })

  return {
    store,
    rerenderWith(next: SetupParams): void {
      applyMocks(next)
      rerender(createElement(AppDataHooksUpdater))
    },
  }
}

describe('AppDataHooksUpdater', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('keeps the hook-store hooks in appData when the sell token changes', () => {
    const { store, rerenderWith } = renderUpdater({ sellToken: SELL_TOKEN_A, postHooks: ONE_POST_HOOK })

    expect(store.get(appDataHooksAtom)?.post?.map((hook) => hook.target)).toEqual([POST_HOOK_TARGET])

    rerenderWith({ sellToken: SELL_TOKEN_B, postHooks: ONE_POST_HOOK })

    expect(store.get(appDataHooksAtom)?.post?.map((hook) => hook.target)).toEqual([POST_HOOK_TARGET])
  })

  it('drops the permit of the previous sell token when the sell token changes', () => {
    const { store, rerenderWith } = renderUpdater({ sellToken: SELL_TOKEN_A, hasAllowance: false, permit: PERMIT })

    expect(store.get(appDataHooksAtom)?.pre?.map((hook) => hook.target)).toEqual([PERMIT_TARGET])

    rerenderWith({ sellToken: SELL_TOKEN_B, hasAllowance: false, permit: undefined })

    expect(store.get(appDataHooksAtom)).toBeUndefined()
  })
})
