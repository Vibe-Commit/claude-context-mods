export type Label = string | null

declare module 'claude-code' {
  interface PluginState {
    'context-meter': { label: Label }
  }
}
