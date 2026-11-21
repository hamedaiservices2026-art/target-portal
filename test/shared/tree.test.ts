import { describe, expect, it } from 'vitest';
import { ancestors, descendants, isInBranch, lowestCommonAncestor } from '../../src/shared/tree';

// Two departments (two roots), three levels in the first:
//   1
//   ├─ 2
//   │  ├─ 4
//   │  └─ 5
//   └─ 3
//      └─ 6
//   7            (other department)
//   └─ 8
const nodes = [
  { id: 1, parent_id: null },
  { id: 2, parent_id: 1 },
  { id: 3, parent_id: 1 },
  { id: 4, parent_id: 2 },
  { id: 5, parent_id: 2 },
  { id: 6, parent_id: 3 },
  { id: 7, parent_id: null },
  { id: 8, parent_id: 7 },
];

describe('descendants', () => {
  it('returns every node below, excluding the node itself', () => {
    expect(descendants(nodes, 1).sort()).toEqual([2, 3, 4, 5, 6]);
    expect(descendants(nodes, 2).sort()).toEqual([4, 5]);
  });
  it('returns [] for a leaf or an unknown id', () => {
    expect(descendants(nodes, 4)).toEqual([]);
    expect(descendants(nodes, 99)).toEqual([]);
  });
});

describe('ancestors', () => {
  it('returns parent first, root last, excluding the node itself', () => {
    expect(ancestors(nodes, 4)).toEqual([2, 1]);
    expect(ancestors(nodes, 8)).toEqual([7]);
  });
  it('returns [] for a root or an unknown id', () => {
    expect(ancestors(nodes, 1)).toEqual([]);
    expect(ancestors(nodes, 99)).toEqual([]);
  });
});

describe('lowestCommonAncestor', () => {
  it('cousins share their grandparent', () => {
    expect(lowestCommonAncestor(nodes, 4, 6)).toBe(1);
  });
  it('siblings share their parent', () => {
    expect(lowestCommonAncestor(nodes, 4, 5)).toBe(2);
  });
  it('a node and its descendant: the node itself is the ancestor', () => {
    expect(lowestCommonAncestor(nodes, 2, 5)).toBe(2);
    expect(lowestCommonAncestor(nodes, 5, 2)).toBe(2);
    expect(lowestCommonAncestor(nodes, 4, 4)).toBe(4);
  });
  it('is null across departments', () => {
    expect(lowestCommonAncestor(nodes, 4, 8)).toBeNull();
  });
  it('is null for an unknown id', () => {
    expect(lowestCommonAncestor(nodes, 4, 99)).toBeNull();
  });
});

describe('isInBranch', () => {
  it('is true for the root itself and anything below it', () => {
    expect(isInBranch(nodes, 2, 2)).toBe(true);
    expect(isInBranch(nodes, 1, 5)).toBe(true);
  });
  it('is false for siblings, ancestors and other departments', () => {
    expect(isInBranch(nodes, 2, 6)).toBe(false);
    expect(isInBranch(nodes, 4, 2)).toBe(false);
    expect(isInBranch(nodes, 1, 8)).toBe(false);
  });
});
