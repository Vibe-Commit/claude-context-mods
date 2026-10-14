export type HandoffPhase = 'idle' | 'nudged' | 'pending' | 'compacting' | 'resuming'

declare module 'claude-code' {
  interface PluginState {
    'context-handoff': {
      phase: HandoffPhase
      handoffPath: string
      isFirmSent: boolean
      isOvershootSent: boolean
      isDisabled: boolean
      handoffCount: number
      resumeTurnId: string
      lateMessages: string
      compactOutcome: string
      heldMessages: string[]
      heldHanded: number
      isNoteRead: boolean
      isHoldReleased: boolean
      holdToken: string
      watchdogToken: string
      foreignTurnId: string
    }
  }
}
