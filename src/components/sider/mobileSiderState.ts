import { create } from 'zustand'

/** 移动端侧边栏抽屉：顶栏菜单按钮打开，点遮罩、切换会话或开启新对话后关闭 */
export const useMobileSider = create(() => ({
  open: false,
  offset: 0,
  progress: 0,
  dragging: false,
}))

export const openMobileSider = () => useMobileSider.setState({ open: true, progress: 1 })

export const closeMobileSider = () => useMobileSider.setState({ open: false, progress: 0 })

export const setMobileSiderOffset = (offset: number, progress: number, dragging: boolean) =>
  useMobileSider.setState({ offset, progress, dragging })
