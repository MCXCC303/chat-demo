import { createContext, useContext } from 'react'

/** 渲染更新后请求滚到底部；用户上滑离开底部时由列表忽略 */
export const ScrollToBottomContext = createContext<() => void>(() => {})

export const useScrollToBottom = () => useContext(ScrollToBottomContext)

export type ScrollToLatestState = {
  visible: boolean
  streaming: boolean
  scrollToLatest: () => void
}

export const ScrollToLatestContext = createContext<ScrollToLatestState>({
  visible: false,
  streaming: false,
  scrollToLatest: () => {},
})

export const useScrollToLatest = () => useContext(ScrollToLatestContext)
