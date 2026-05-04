import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('exporters package', () => {
  it('reports its package name', () => {
    expect(PACKAGE_NAME).toBe('@vibe-tx-converter/exporters');
  });
});
