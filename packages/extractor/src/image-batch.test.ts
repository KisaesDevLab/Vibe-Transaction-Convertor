import { describe, expect, it } from 'vitest';

import { batchPageImages, type BatchImage } from './image-batch.js';

const page = (bytes: number): BatchImage => ({
  data: Buffer.alloc(bytes, 1),
  mediaType: 'image/jpeg',
});

describe('batchPageImages', () => {
  it('caps batches at maxPagesPerBatch and numbers startPage globally', () => {
    const pages = [page(10), page(10), page(10), page(10), page(10)];
    const batches = batchPageImages(pages, { maxPagesPerBatch: 2, maxBatchBytes: 1_000_000 });
    expect(batches.map((b) => b.images.length)).toEqual([2, 2, 1]);
    expect(batches.map((b) => b.startPage)).toEqual([1, 3, 5]);
  });

  it('starts a new batch when the byte budget would be exceeded', () => {
    // base64 size of 300 raw bytes ≈ 400. Budget 900 fits two pages, not three.
    const pages = [page(300), page(300), page(300), page(300)];
    const batches = batchPageImages(pages, { maxPagesPerBatch: 10, maxBatchBytes: 900 });
    expect(batches.map((b) => b.images.length)).toEqual([2, 2]);
    expect(batches.map((b) => b.startPage)).toEqual([1, 3]);
  });

  it('puts a single over-budget page in its own batch rather than dropping it', () => {
    const pages = [page(10), page(5_000_000), page(10)];
    const batches = batchPageImages(pages, { maxPagesPerBatch: 3, maxBatchBytes: 1_000 });
    // page 1 alone (next is over budget), the giant page alone, then page 3.
    expect(batches.map((b) => b.images.length)).toEqual([1, 1, 1]);
    expect(batches.map((b) => b.startPage)).toEqual([1, 2, 3]);
  });

  it('returns a single batch for a small statement (identity-friendly)', () => {
    const batches = batchPageImages([page(10), page(10)], {
      maxPagesPerBatch: 3,
      maxBatchBytes: 1_000_000,
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.startPage).toBe(1);
    expect(batches[0]!.images).toHaveLength(2);
  });

  it('handles an empty page list', () => {
    expect(batchPageImages([])).toEqual([]);
  });
});
