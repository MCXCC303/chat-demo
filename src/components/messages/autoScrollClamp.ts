/**
 * 自动滚动钳制：正文起始位置到达展示区域顶端时停止跟随。
 *
 * 行为与官网一致：流式生成时把视图滚动到「正文顶端正好贴着滚动视口顶端」，
 * 随后关闭跟随；冻结对每条消息只触发一次，用户手动回到底部后恢复跟随且不再重复冻结。
 */

export type ScrollClampResult = {
  /** 目标 scrollTop */
  target: number
  /** 是否触发冻结：本次不再跟随 */
  shouldStop: boolean
}

/**
 * 计算下一次滚动调整的目标位置。
 *
 * @param bodyTopOffset 正文顶端相对滚动视口顶端的偏移；null 表示正文尚未渲染
 * @param stopped 本条消息是否已触发过冻结
 */
export const clampScrollTop = ({
  scrollHeight,
  clientHeight,
  scrollTop,
  bodyTopOffset,
  stopped,
}: {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
  bodyTopOffset: number | null
  stopped: boolean
}): ScrollClampResult => {
  const bottomTarget = scrollHeight - clientHeight
  if (!Number.isFinite(bottomTarget)) {
    return { target: scrollTop, shouldStop: false }
  }
  // 已冻结过、正文尚未渲染，或正文顶端已越过视口顶端：正常跟到底部
  if (stopped || bodyTopOffset === null || bodyTopOffset < -1) {
    return { target: bottomTarget, shouldStop: false }
  }
  // 正文顶端的文档绝对位置
  const bodyTop = scrollTop + bodyTopOffset
  if (!Number.isFinite(bodyTop) || bodyTop >= bottomTarget - 1) {
    return { target: bottomTarget, shouldStop: false }
  }
  // 滚到底会把正文顶端挤出视口：只滚到正文顶端对齐视口顶端，随后停止跟随
  return { target: Math.max(bodyTop, scrollTop), shouldStop: true }
}
