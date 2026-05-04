import { describe, expect, it } from 'vitest';
import { APP_NAME } from './index.js';

describe('api app', () => {
  it('reports its package name', () => {
    expect(APP_NAME).toBe('@vibe-tx-converter/api');
  });
});
