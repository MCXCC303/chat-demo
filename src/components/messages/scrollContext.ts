import { createContext, useContext } from 'react'

/** 渲染更新后请求滚到底部；用户上滑离开底部时由列表忽略 */
export const ScrollToBottomContext = createContext<() => void>(() => {})

export const useScrollToBottom = () => useContext(ScrollToBottomContext)

/** 回到底部按钮：由消息列表提供可见性与点击行为 */
export type ScrollToLatestState = {
  /** 已离开底部时显示 */
  visible: boolean
  /** 是否有回复正在生成；生成中按钮带品牌光环 */
  streaming: boolean
  /** 回到最新消息并恢复跟随 */
  scrollToLatest: () => void
}

export const ScrollToLatestContext = createContext<ScrollToLatestState>({
  visible: false,
  streaming: false,
  scrollToLatest: () => {},
})

export const useScrollToLatest = () => useContext(ScrollToLatestContext)
