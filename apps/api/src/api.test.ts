import { describe, expect, it } from 'vitest';
import { createApp } from './server.js';

describe('api app', () => {
  it('createApp returns a configured Express app', () => {
    const app = createApp();
    expect(app).toBeDefined();
    expect(typeof (app as { use: unknown }).use).toBe('function');
  });
});
