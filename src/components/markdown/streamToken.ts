import { createContext } from 'react'

export type StreamTokenState = {
  streaming: boolean
  animate: boolean
  initial: boolean
}

export const StreamTokenContext = createContext<StreamTokenState>({
  streaming: false,
  animate: false,
  initial: false,
})
