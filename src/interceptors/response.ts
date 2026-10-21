import { handleRequest } from '../context'
import { BaseMiddleware, Interceptor } from '../types'
import { getGlobalThis } from './fetch'
import { deliveredByRequestChannel, makeLookNative, responseNatives } from './shared'


export interface ResponseContext {
  type: 'response'
  req: { url: string; method: string }
  res: Response
  via: 'arrayBuffer' | 'json' | 'text'

  [key: string]: any
}

export interface ResponseMiddleware {
  (c: ResponseContext, next: () => Promise<void>): void | Promise<void>
}

/*
export async function readBodyUntracked(
  res: Response,
  how: 'arrayBuffer' | 'json' | 'text',
): Promise<any> {
  const native =
    responseNatives[how] ??
    (Response.prototype as any)[how] ??
    (res as any)[how]?.bind(res)
  if (typeof native !== 'function') {
    throw new Error(`[vista] Response.${how} недоступен`)
  }
  return native.call(res)
}
*/

export const interceptResponse: Interceptor<ResponseMiddleware> = function (
  middlewares: BaseMiddleware<ResponseContext>[],
) {
  const globalContext = getGlobalThis() as any
  if (typeof globalContext.Response === 'undefined') return () => {}

  if (!middlewares || middlewares.length === 0) return () => {}

  const proto: any = globalContext.Response.prototype

  const dispatch = (
    res: Response,
    via: 'arrayBuffer' | 'json' | 'text',
  ): void => {
    try {
      const url = res.url || ''
      if (!url) return
      if (deliveredByRequestChannel.has(res)) return

      const c: ResponseContext = {
        type: 'response',
        req: { url, method: '' },
        res,
        via,
      }
      handleRequest(c, middlewares as BaseMiddleware<ResponseContext>[]).catch(
        (err) => {
          console.error('[vista] response middleware failed', err)
        },
      )
    } catch (err) {
      console.error('[vista] response dispatch failed', err)
    }
  }

  const installed: Array<{
    name: 'arrayBuffer' | 'json' | 'text'
    orig: any
    wrapped: any
  }> = []

  for (const name of ['arrayBuffer', 'json', 'text'] as const) {
    const orig = proto[name]
    if (typeof orig !== 'function') continue

    const wrapped = async function (this: Response) {
      dispatch(this, name)
      return;
    }
    makeLookNative(wrapped, orig)
    try {
      proto[name] = wrapped
    } catch {
      continue;
    }
    installed.push({ name, orig, wrapped })
  }

  return () => {
    for (const { name, orig, wrapped } of installed) {
      if (proto[name] === wrapped) proto[name] = orig
    }
  }
}
