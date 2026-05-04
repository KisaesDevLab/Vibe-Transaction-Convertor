export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.ok) return r.value;
  throw new Error(`unwrap on Err: ${String(r.error)}`);
};

export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T => (r.ok ? r.value : fallback);

export const map = <T, U, E>(r: Result<T, E>, fn: (t: T) => U): Result<U, E> =>
  r.ok ? ok(fn(r.value)) : r;

export const mapErr = <T, E, F>(r: Result<T, E>, fn: (e: E) => F): Result<T, F> =>
  r.ok ? r : err(fn(r.error));
