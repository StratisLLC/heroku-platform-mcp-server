import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildRangeHeader,
  parsePaginationMeta,
} from '../src/pagination.js';

describe('buildRangeHeader — defaults', () => {
  it('uses 200 as the default page size', () => {
    expect(buildRangeHeader()).toBe(`id ..; max=${DEFAULT_PAGE_SIZE}`);
  });

  it('honours a custom default', () => {
    expect(buildRangeHeader({ defaultPageSize: 50 })).toBe('id ..; max=50');
  });

  it("uses 'id' as the default range property", () => {
    expect(buildRangeHeader()).toMatch(/^id /);
  });

  it('honours a custom property', () => {
    expect(buildRangeHeader({ property: 'version' })).toBe(`version ..; max=${DEFAULT_PAGE_SIZE}`);
  });
});

describe('buildRangeHeader — page size clamping', () => {
  it('clamps page size to max 1000', () => {
    expect(buildRangeHeader({ pageSize: 5000 })).toBe(`id ..; max=${MAX_PAGE_SIZE}`);
  });

  it('clamps page size to min 1', () => {
    expect(buildRangeHeader({ pageSize: 0 })).toBe('id ..; max=1');
    expect(buildRangeHeader({ pageSize: -10 })).toBe('id ..; max=1');
  });

  it('floors fractional page sizes', () => {
    expect(buildRangeHeader({ pageSize: 250.7 })).toBe('id ..; max=250');
  });

  it('handles NaN and Infinity defensively', () => {
    expect(buildRangeHeader({ pageSize: NaN })).toBe('id ..; max=1');
    expect(buildRangeHeader({ pageSize: Infinity })).toBe('id ..; max=1');
  });

  it('respects a custom max', () => {
    expect(buildRangeHeader({ pageSize: 500, maxPageSize: 100 })).toBe('id ..; max=100');
  });
});

describe('buildRangeHeader — cursor handling', () => {
  it('passes a cursor through unchanged when no page size override', () => {
    const cursor = 'id 0123abcd..; max=200; order=asc';
    expect(buildRangeHeader({ cursor })).toBe(cursor);
  });

  it('rewrites the max= field when a page size is also given', () => {
    const cursor = 'id 0123abcd..; max=200; order=asc';
    expect(buildRangeHeader({ cursor, pageSize: 50 })).toBe('id 0123abcd..; max=50; order=asc');
  });

  it('appends max= when cursor lacks it', () => {
    const cursor = 'id 0123abcd..; order=asc';
    expect(buildRangeHeader({ cursor, pageSize: 75 })).toBe('id 0123abcd..; order=asc; max=75');
  });

  it('rewriting max= also clamps', () => {
    const cursor = 'id ..; max=200';
    expect(buildRangeHeader({ cursor, pageSize: 9999 })).toBe(`id ..; max=${MAX_PAGE_SIZE}`);
  });

  it('ignores empty-string cursor', () => {
    expect(buildRangeHeader({ cursor: '' })).toBe(`id ..; max=${DEFAULT_PAGE_SIZE}`);
  });
});

describe('parsePaginationMeta', () => {
  it('returns hasMore=false when no headers present', () => {
    expect(parsePaginationMeta({})).toEqual({ hasMore: false });
  });

  it('treats null/undefined headers as absent', () => {
    expect(parsePaginationMeta({ contentRange: null, nextRange: undefined })).toEqual({
      hasMore: false,
    });
  });

  it('extracts cursor from Next-Range', () => {
    const meta = parsePaginationMeta({
      nextRange: 'id 9999..; max=200; order=asc',
    });
    expect(meta.hasMore).toBe(true);
    expect(meta.cursor).toBe('id 9999..; max=200; order=asc');
  });

  it('extracts total from Content-Range', () => {
    const meta = parsePaginationMeta({
      contentRange: 'id 0..199; max=200, total=4567; order=asc',
    });
    expect(meta.total).toBe(4567);
    expect(meta.contentRange).toBe('id 0..199; max=200, total=4567; order=asc');
  });

  it('does not set total when absent', () => {
    const meta = parsePaginationMeta({
      contentRange: 'id 0..199; max=200; order=asc',
    });
    expect(meta.total).toBeUndefined();
  });

  it('populates both fields when both headers present', () => {
    const meta = parsePaginationMeta({
      contentRange: 'id 0..199; max=200, total=4567; order=asc',
      nextRange: 'id 199..; max=200; order=asc',
    });
    expect(meta.hasMore).toBe(true);
    expect(meta.cursor).toBe('id 199..; max=200; order=asc');
    expect(meta.total).toBe(4567);
  });
});
