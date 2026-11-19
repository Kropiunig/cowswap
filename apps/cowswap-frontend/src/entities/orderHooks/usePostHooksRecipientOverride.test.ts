import { createStore, Provider } from 'jotai'
import { createElement, ReactNode } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { CowHookDetails } from '@cowprotocol/hook-dapp-lib'
import { walletInfoAtom } from '@cowprotocol/wallet'

import { renderHook } from '@testing-library/react'

import { hooksAtom, setHooksAtom } from './hookDetailsAtom'
import { useHooks } from './useHooks'
import { useHooksStateWithSimulatedGas } from './useHooksStateWithSimulatedGas'
import { usePostHooksRecipientOverride } from './usePostHooksRecipientOverride'

jest.mock('modules/tenderly/hooks/useTenderlyBundleSimulation', () => ({
  useTenderlyBundleSimulation: () => ({ data: undefined }),
}))

const HOOKS_STORAGE_KEY = 'hooksStoreAtom:v3'
const RECIPIENT_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const RECIPIENT_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

let accountSeed = 0

function makeHook(uuid: string, recipientOverride?: string): CowHookDetails {
  return {
    uuid,
    recipientOverride,
    hook: { target: '0x3333333333333333333333333333333333333333', callData: '0x', gasLimit: '21000', dappId: 'dapp' },
  }
}

function setup(postHooks: CowHookDetails[]): {
  store: ReturnType<typeof createStore>
  wrapper: typeof Wrapper
  account: string
} {
  // jotai's JSON storage returns the previously parsed object while the stored string is unchanged,
  // so each test writes under its own account to keep the parsed hooks apart
  const account = `0x${String(++accountSeed).padStart(40, '0')}`
  const store = createStore()
  store.set(walletInfoAtom, { account, chainId: SupportedChainId.MAINNET })
  store.set(setHooksAtom, { preHooks: [], postHooks })

  function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return createElement(Provider, { store }, children)
  }

  return { store, wrapper: Wrapper, account }
}

describe('usePostHooksRecipientOverride', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns the override of the last post hook that has one', () => {
    const { wrapper } = setup([makeHook('a', RECIPIENT_A), makeHook('b', RECIPIENT_B), makeHook('c')])

    expect(renderHook(() => usePostHooksRecipientOverride(), { wrapper }).result.current).toBe(RECIPIENT_B)
  })

  it('returns undefined when no post hook overrides the recipient', () => {
    const { wrapper } = setup([makeHook('a'), makeHook('b')])

    expect(renderHook(() => usePostHooksRecipientOverride(), { wrapper }).result.current).toBeUndefined()
  })

  it('leaves the stored post hooks order untouched', () => {
    const { store, wrapper } = setup([makeHook('a', RECIPIENT_A), makeHook('b', RECIPIENT_B)])

    renderHook(() => usePostHooksRecipientOverride(), { wrapper })

    expect(store.get(hooksAtom).postHooks.map((hook) => hook.uuid)).toEqual(['a', 'b'])
  })

  it('gives every caller in the same tree the same override', () => {
    const { wrapper } = setup([makeHook('a', RECIPIENT_A), makeHook('b', RECIPIENT_B)])

    const { result } = renderHook(() => [usePostHooksRecipientOverride(), usePostHooksRecipientOverride()], {
      wrapper,
    })

    expect(result.current).toEqual([RECIPIENT_B, RECIPIENT_B])
  })

  it('keeps the order the appData hooks are built from after a page that only read the override', () => {
    const { wrapper } = setup([makeHook('a', RECIPIENT_A), makeHook('b', RECIPIENT_B)])

    // The hooks store stays subscribed for the whole session (BalancesCombinedUpdater reads it app-wide)
    renderHook(() => useHooks(), { wrapper })

    // A trade page other than Hooks mounts one reader of the override (TradeWidgetUpdaters)
    renderHook(() => usePostHooksRecipientOverride(), { wrapper }).unmount()

    // Back on the Hooks page, AppDataHooksUpdater builds the order's hooks from this state
    const { result } = renderHook(() => useHooksStateWithSimulatedGas(), { wrapper })

    expect(result.current.postHooks.map((hook) => hook.uuid)).toEqual(['a', 'b'])
  })

  it('persists the order the user set when a hook is added afterwards', () => {
    const { store, wrapper, account } = setup([makeHook('a', RECIPIENT_A), makeHook('b', RECIPIENT_B)])

    renderHook(() => usePostHooksRecipientOverride(), { wrapper })
    store.set(setHooksAtom, (state) => ({ ...state, postHooks: [...state.postHooks, makeHook('c')] }))

    const persisted = JSON.parse(String(localStorage.getItem(HOOKS_STORAGE_KEY))) as Record<
      string,
      Record<string, { postHooks: CowHookDetails[] }>
    >

    expect(persisted[SupportedChainId.MAINNET][account].postHooks.map((hook) => hook.uuid)).toEqual(['a', 'b', 'c'])
  })
})
