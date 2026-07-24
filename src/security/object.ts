export function defineOwn<T>(
  target: Record<string, T>,
  key: string,
  value: T,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export function deleteOwn(
  target: Record<string, unknown>,
  key: string,
): void {
  Reflect.deleteProperty(target, key);
}
