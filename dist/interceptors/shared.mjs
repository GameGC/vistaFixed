export const deliveredByRequestChannel = /* @__PURE__ */ new WeakSet();
export function markDelivered(res) {
  try {
    deliveredByRequestChannel.add(res);
  } catch {
  }
}
export const responseNatives = (() => {
  try {
    if (typeof Response === "undefined" || !Response.prototype) return {};
    return {
      arrayBuffer: Response.prototype.arrayBuffer,
      json: Response.prototype.json,
      text: Response.prototype.text
    };
  } catch {
    return {};
  }
})();
const originalDefineProperty = Object.defineProperty;
const originalFunctionToString = Function.prototype.toString;
export function makeLookNative(replacementFn, nativeFn) {
  const nativeSource = originalFunctionToString.call(nativeFn);
  originalDefineProperty(replacementFn, "toString", {
    value() {
      return nativeSource;
    },
    writable: true,
    configurable: true,
    enumerable: false
  });
  try {
    originalDefineProperty(replacementFn, "name", { value: nativeFn.name, configurable: true });
  } catch (_) {
  }
  try {
    originalDefineProperty(replacementFn, "length", { value: nativeFn.length, configurable: true });
  } catch (_) {
  }
  return replacementFn;
}
