import { BaseMiddleware } from '../types'

export const deliveredByRequestChannel: WeakSet<object> = new WeakSet()

/** Пометить Response как доставленный запросным каналом. */
export function markDelivered(res: object): void {
  try {
    deliveredByRequestChannel.add(res)
  } catch {
    /* не катастрофа — худший случай двойная доставка */
  }
}


export const responseNatives: Partial<
  Record<'arrayBuffer' | 'json' | 'text', any>
> = (() => {
  try {
    if (typeof Response === 'undefined' || !Response.prototype) return {}
    return {
      arrayBuffer: Response.prototype.arrayBuffer,
      json: Response.prototype.json,
      text: Response.prototype.text,
    }
  } catch {
    return {}
  }
})()

const originalDefineProperty = Object.defineProperty
const originalFunctionToString = Function.prototype.toString

/** Маскировка патченых методов под нативные (анти-детект toString). */
export function makeLookNative(replacementFn: any, nativeFn: any) {
  const nativeSource = originalFunctionToString.call(nativeFn)
  originalDefineProperty(replacementFn, 'toString', {
    value() { return nativeSource },
    writable: true,
    configurable: true,
    enumerable: false,
  })
  try {
    originalDefineProperty(replacementFn, 'name', { value: nativeFn.name, configurable: true })
  } catch (_) {}
  try {
    originalDefineProperty(replacementFn, 'length', { value: nativeFn.length, configurable: true })
  } catch (_) {}
  return replacementFn
}
