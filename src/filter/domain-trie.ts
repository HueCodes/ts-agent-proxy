/**
 * Domain trie for efficient domain pattern matching.
 *
 * Provides O(log n) lookup for domain matching by organizing
 * domain patterns in a trie structure indexed by domain segments.
 *
 * Supports:
 * - Exact domain matching (api.example.com)
 * - Single-level wildcard (*.example.com)
 * - Multi-level wildcard (**.example.com)
 */

import type { AllowlistRule } from '../types/allowlist.js';

/**
 * Node in the domain trie.
 */
interface TrieNode {
  /** Rules that match at this exact node */
  exactRules: AllowlistRule[];
  /** Rules with single-level wildcard (*.) at this level */
  wildcardRules: AllowlistRule[];
  /** Rules with multi-level wildcard (**.) at this level */
  deepWildcardRules: AllowlistRule[];
  /** Child nodes indexed by domain segment */
  children: Map<string, TrieNode>;
}

/**
 * Domain trie for efficient rule lookup.
 *
 * The trie is indexed by reversed domain segments for efficient
 * suffix matching (e.g., "api.example.com" → ["com", "example", "api"]).
 */
export class DomainTrie {
  private readonly root: TrieNode;
  private ruleCount = 0;

  /** Index for exact domain lookups (O(1)) */
  private readonly exactDomainIndex: Map<string, AllowlistRule[]>;

  constructor() {
    this.root = this.createNode();
    this.exactDomainIndex = new Map();
  }

  /**
   * Create an empty trie node.
   */
  private createNode(): TrieNode {
    return {
      exactRules: [],
      wildcardRules: [],
      deepWildcardRules: [],
      children: new Map(),
    };
  }

  /**
   * Add a rule to the trie.
   */
  addRule(rule: AllowlistRule): void {
    if (rule.enabled === false) return;

    const domain = rule.domain.toLowerCase();
    this.ruleCount++;

    // Handle exact domain match (no wildcards)
    if (!domain.includes('*')) {
      // Add to exact index for O(1) lookup
      const existing = this.exactDomainIndex.get(domain) ?? [];
      existing.push(rule);
      this.exactDomainIndex.set(domain, existing);

      // Also add to trie for wildcard matching
      this.addToTrie(domain, rule, 'exact');
      return;
    }

    // Handle wildcard patterns
    if (domain.startsWith('**.')) {
      // Multi-level wildcard: **.example.com
      const baseDomain = domain.slice(3); // Remove "**."
      this.addToTrie(baseDomain, rule, 'deepWildcard');
    } else if (domain.startsWith('*.')) {
      // Single-level wildcard: *.example.com
      const baseDomain = domain.slice(2); // Remove "*."
      this.addToTrie(baseDomain, rule, 'wildcard');
    } else {
      // Wildcard in middle or end (treat as exact with pattern)
      // This is an edge case - add to exact index
      const existing = this.exactDomainIndex.get(domain) ?? [];
      existing.push(rule);
      this.exactDomainIndex.set(domain, existing);
    }
  }

  /**
   * Add a rule to the trie at the specified location.
   */
  private addToTrie(
    domain: string,
    rule: AllowlistRule,
    type: 'exact' | 'wildcard' | 'deepWildcard'
  ): void {
    const segments = this.reverseDomainSegments(domain);
    let node = this.root;

    // Navigate/create path to the target node
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (!child) {
        child = this.createNode();
        node.children.set(segment, child);
      }
      node = child;
    }

    // Add rule to appropriate list
    switch (type) {
      case 'exact':
        node.exactRules.push(rule);
        break;
      case 'wildcard':
        node.wildcardRules.push(rule);
        break;
      case 'deepWildcard':
        node.deepWildcardRules.push(rule);
        break;
    }
  }

  /**
   * Find all rules that match a domain.
   * Returns rules in order of specificity (most specific first).
   */
  findMatchingRules(domain: string): AllowlistRule[] {
    const normalizedDomain = domain.toLowerCase();
    const results: AllowlistRule[] = [];

    // 1. Check exact domain index first (O(1))
    const exactMatches = this.exactDomainIndex.get(normalizedDomain);
    if (exactMatches) {
      results.push(...exactMatches);
    }

    // 2. Walk the trie collecting wildcard matches
    const segments = this.reverseDomainSegments(normalizedDomain);
    this.collectWildcardMatches(this.root, segments, 0, results);

    return results;
  }

  /**
   * Recursively collect wildcard matches from the trie.
   */
  private collectWildcardMatches(
    node: TrieNode,
    segments: string[],
    index: number,
    results: AllowlistRule[]
  ): void {
    // Deep wildcard rules at this node match all remaining segments
    if (node.deepWildcardRules.length > 0 && index < segments.length) {
      results.push(...node.deepWildcardRules);
    }

    // If we've processed all segments
    if (index >= segments.length) {
      // Single-level wildcard at this level matches if there's exactly one more segment
      // But we're at the end, so check if wildcard rules should match
      return;
    }

    const segment = segments[index];
    const child = node.children.get(segment);

    if (child) {
      // Check for single-level wildcard match
      // Wildcard *.example.com should match sub.example.com but NOT example.com
      // This means we need exactly one more segment that doesn't have a trie match
      if (index < segments.length - 1) {
        // There are more segments - check if next segment should trigger wildcard
        const grandchild = child.children.get(segments[index + 1]);
        if (!grandchild) {
          // No exact match for next segment, check if wildcard applies
          // Only match if there's exactly one more segment (the wildcard match)
          if (child.wildcardRules.length > 0 && segments.length - index === 2) {
            results.push(...child.wildcardRules);
          }
        }
      }

      // Continue traversing
      this.collectWildcardMatches(child, segments, index + 1, results);
    }
  }

  /**
   * Check if any rule matches a domain.
   * More efficient than findMatchingRules when you only need a boolean.
   */
  hasMatch(domain: string): boolean {
    const normalizedDomain = domain.toLowerCase();

    // Check exact index first
    if (this.exactDomainIndex.has(normalizedDomain)) {
      return true;
    }

    // Check trie for wildcard matches
    const segments = this.reverseDomainSegments(normalizedDomain);
    return this.hasWildcardMatch(this.root, segments, 0);
  }

  /**
   * Recursively check for wildcard matches.
   */
  private hasWildcardMatch(node: TrieNode, segments: string[], index: number): boolean {
    // Deep wildcard at this node matches
    if (node.deepWildcardRules.length > 0 && index < segments.length) {
      return true;
    }

    if (index >= segments.length) {
      return false;
    }

    const segment = segments[index];
    const child = node.children.get(segment);

    if (!child) {
      return false;
    }

    // Check single-level wildcard
    if (child.wildcardRules.length > 0 && index === segments.length - 2) {
      return true;
    }

    return this.hasWildcardMatch(child, segments, index + 1);
  }

  /**
   * Reverse domain segments for trie indexing.
   * "api.example.com" → ["com", "example", "api"]
   */
  private reverseDomainSegments(domain: string): string[] {
    return domain.split('.').reverse();
  }

  /**
   * Clear all rules from the trie.
   */
  clear(): void {
    this.root.children.clear();
    this.root.exactRules = [];
    this.root.wildcardRules = [];
    this.root.deepWildcardRules = [];
    this.exactDomainIndex.clear();
    this.ruleCount = 0;
  }

  /**
   * Get the number of rules in the trie.
   */
  getRuleCount(): number {
    return this.ruleCount;
  }

  /**
   * Get statistics about the trie.
   */
  getStats(): {
    ruleCount: number;
    exactDomains: number;
    nodeCount: number;
    maxDepth: number;
  } {
    const stats = {
      ruleCount: this.ruleCount,
      exactDomains: this.exactDomainIndex.size,
      nodeCount: 0,
      maxDepth: 0,
    };

    const countNodes = (node: TrieNode, depth: number): void => {
      stats.nodeCount++;
      stats.maxDepth = Math.max(stats.maxDepth, depth);
      for (const child of node.children.values()) {
        countNodes(child, depth + 1);
      }
    };

    countNodes(this.root, 0);
    return stats;
  }
}

/**
 * Create a domain trie from a list of rules.
 */
export function createDomainTrie(rules: AllowlistRule[]): DomainTrie {
  const trie = new DomainTrie();
  for (const rule of rules) {
    trie.addRule(rule);
  }
  return trie;
}
