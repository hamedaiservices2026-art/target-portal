export type PackCode = string;
export type PackGroup = 'CSD' | 'Water' | 'LRB-Others';
export type Grid = Record<PackCode, number>;           // whole cases per pack
export type ChildKey = `n:${number}` | `l:${number}`;   // child node or leaf
export type NodeStatus = 'waiting' | 'in_progress' | 'submitted';
export interface Issue { level: 'error' | 'warning'; code: IssueCode; line?: number; detail: string }
export type IssueCode = 'unknown_pack' | 'period_mismatch' | 'bad_cases' | 'duplicate'
  | 'unmapped_leaf' | 'leaf_in_other_file' | 'blank_salesman' | 'split_salesman'
  | 'all_zero_leaf' | 'missing_pack';
