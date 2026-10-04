import { describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';

// The tests run without a DOM, so drive the lifecycle method on a bare
// instance (setState is stubbed — there is no renderer behind it).
const crash = new Error('boom');

const boundary = (resetKey: string, error: Error | null) => {
  const b = new ErrorBoundary({ children: null, resetKey });
  b.state = { error, showStack: true };
  const setState = vi.spyOn(b, 'setState').mockImplementation(() => {});
  return { b, setState };
};

describe('ErrorBoundary resetKey', () => {
  it('clears an error already on screen when the resetKey changes', () => {
    const { b, setState } = boundary('/b', crash);
    b.componentDidUpdate({ children: null, resetKey: '/a' }, { error: crash, showStack: true });
    expect(setState).toHaveBeenCalledWith({ error: null, showStack: false });
  });

  it('keeps the error while the resetKey is unchanged', () => {
    const { b, setState } = boundary('/a', crash);
    b.componentDidUpdate({ children: null, resetKey: '/a' }, { error: crash, showStack: false });
    expect(setState).not.toHaveBeenCalled();
  });

  it('does not clear the error in the update that first shows it', () => {
    // A route that crashes on arrival: the new path and the error land together.
    const { b, setState } = boundary('/b', crash);
    b.componentDidUpdate({ children: null, resetKey: '/a' }, { error: null, showStack: false });
    expect(setState).not.toHaveBeenCalled();
  });

  it('leaves the children alone on a path change when nothing has crashed', () => {
    const { b, setState } = boundary('/b', null);
    b.componentDidUpdate({ children: null, resetKey: '/a' }, { error: null, showStack: false });
    expect(setState).not.toHaveBeenCalled();
  });
});
