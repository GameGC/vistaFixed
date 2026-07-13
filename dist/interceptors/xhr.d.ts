import type { Interceptor } from '../types';
import { type FetchMiddleware } from './fetch';
/**
 * Intercepts XHR by patching `open`, `setRequestHeader`, and `send` on the
 * prototype — the same minimal-surface approach used by `interceptFetch`.
 *
 * Each call to `send` builds a `FetchContext`, runs it through the middleware
 * pipeline, then forwards the (possibly mutated) request to the native XHR.
 * A teardown function is returned that restores all three originals.
 */
export declare const interceptXHR: Interceptor<FetchMiddleware>;
