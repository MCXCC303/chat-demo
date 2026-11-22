import { createContext } from 'react'

/** 流式生成中：正文按字符包一层渐入元素，已渲染的字符保持稳定 key，不重复播放动画 */
export const StreamTokenContext = createContext(false)
