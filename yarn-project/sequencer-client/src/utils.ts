/**
 * Returns a promise that resolves after ms milliseconds, returning retval.
 * @param ms - How many milliseconds to sleep.
 * @param retval - The return value of the promise.
 */
export function sleep<T>(ms: number, retval: T): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(retval), ms));
}

/**
 * Returns the lowest power of two that is greater of equal to the input.
 * @param num - The input.
 */
export function ceilPowerOfTwo(num: number): number {
  return 2 ** Math.ceil(Math.log2(num));
}
