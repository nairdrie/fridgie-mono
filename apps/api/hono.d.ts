// src/hono.d.ts
import 'hono'

declare module 'hono' {
  interface ContextVariableMap {
    uid: string
  }
}