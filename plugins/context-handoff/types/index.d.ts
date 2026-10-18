export type HandoffPhase = 'idle' | 'nudged' | 'pending' | 'compacting' | 'resuming'

// The ledger file, ~/.claude/handoffs/<session>/ledger.json: the record of what
// was said and the items in force, which a handoff carries across the compaction.
// ledger.ts and register.ts share these shapes.
export type LedgerFile = {
  v: 1
  /** When recording began (ms); a note says so, since nothing earlier is in the record. */
  since: number
  /** The last record entry number issued (`R<n>`); never reused. */
  entrySeq: number
  /** The last item number issued (`L<n>`); never reused. */
  itemSeq: number
  /** The highest note number written (`handoff-<n>.md`), which outlives a deleted note. */
  lastNote: number
  /** Handoffs completed (the note read back). */
  done: number
  /** The last entry number the previous completed handoff covered; pruning keeps the window after it. */
  lastCut: number
  /** The cut of the handoff completed before the last one; pruning keeps uncited entries after it. */
  prevCut: number
  record: RecordEntry[]
  items: LedgerItem[]
  /**
   * What the Handoff call received, kept apart until the handoff completes: the note's number,
   * the last entry number the note covered (the new `lastCut` once it completes), the call's
   * time, and the ops that were applied, normalised, to be replayed at that time.
   */
  staged?: { note: number; cut: number; at: number; ops: LedgerOp[] }
}

/** One message in the record, exact: what the user typed, a delivery, or an answer to a question. */
export type RecordEntry = {
  id: string
  /** When it arrived (ms). */
  at: number
  /** Who sent it, as a label (`senderOf`), newlines removed. */
  from: string
  /** The sending session's own name, from the engine's `from-name` attribute; the sender chooses it, so it labels and never authorizes. */
  name?: string
  kind: 'prompt' | 'delivery' | 'answer'
  /** The text, cut at 20,000 characters. */
  text: string
  /** Set when `text` was cut. */
  isCut?: true
  /** Set when the sender could not be placed (a channel, an unclassified delivery). */
  isUnverified?: true
  /**
   * Set on another session's message that reached `session.receive` and was not taken by
   * the hold: the engine may still be keeping it for the user's approval. Cleared when its
   * row reaches `session.append`. A pending entry is not shown and is not a source.
   */
  isPending?: true
}

export type LedgerKind = 'intent' | 'rule' | 'ruling' | 'spec' | 'decision'

/** One thing in force across handoffs: carried by code, changed only by an op. */
export type LedgerItem = {
  id: string
  kind: LedgerKind
  text: string
  /** The record entries it cites, as `R<n>` ids. */
  sources: string[]
  /** Who decided it, taken from its first source. */
  from: string
  /** When it was decided (ms): its first resolved source's time, else when it was added. */
  at: number
  /** Earlier texts of an amended item, newest last. */
  history: { text: string; until: number; why: string }[]
  retired?: { at: number; why: string }
}

/** What the Handoff call's `ledger` input may hold. */
export type LedgerOp =
  | { op: 'add'; kind: LedgerKind; text: string; sources?: string[] }
  | { op: 'amend'; id: string; text: string; why: string; sources?: string[] }
  | { op: 'retire'; id: string; why: string }

declare module 'claude-code' {
  interface PluginState {
    'context-handoff': {
      phase: HandoffPhase
      handoffPath: string
      isFirmSent: boolean
      isOvershootSent: boolean
      isDisabled: boolean
      resumeTurnId: string
      lateMessages: string
      compactOutcome: string
      heldMessages: string[]
      heldHanded: number
      isNoteRead: boolean
      noteLines: [from: number, to: number][]
      /** The ledger as it stands when the last write to ledger.json failed, kept until a write succeeds. */
      unsavedLedger: LedgerFile | null
      /** Typed prompts seen at prompt.submit whose engine row has not yet reached session.append. */
      typedPending: string[]
      isHoldReleased: boolean
      holdToken: string
      watchdogToken: string
      foreignTurnId: string
    }
  }
}
