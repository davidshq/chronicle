# Codebase Review - Strategic Health Check

Perform a comprehensive review of the entire codebase from the perspective of a pragmatic software engineer and technical lead. This review serves two purposes: (1) identify issues and technical debt, and (2) evaluate strategic direction and documentation currency.

- For each item you report on, provide a pragmatic engineers evaluation of the importance and quality of the recommendation (e.g. skip to critical, overarchitecting, etc.)

---

## Part 1: Issue Detection (Full Codebase)

Scan the entire codebase (not just recent changes) for:

### Code Quality Issues
1. **Bugs and Potential Errors** - Logic errors, edge cases, race conditions
2. **Security Vulnerabilities** - OWASP top 10, injection risks, insecure defaults
3. **Performance Issues** - O(n²) algorithms, memory leaks, unnecessary allocations
4. **Error Handling Gaps** - Unhandled errors, poor error messages, missing recovery
5. **Code Smells** - DRY violations, overly complex functions, tight coupling
6. **Dead Code** - Unused functions, unreachable branches, deprecated paths
7. **Anti-patterns** - Language-specific pitfalls, misuse of features

### Structural Issues
1. **Architectural Violations** - Does code follow stated architecture in CLAUDE.md?
2. **Dependency Issues** - Outdated deps, security vulnerabilities, unnecessary deps
3. **Test Coverage Gaps** - Critical paths without tests, flaky tests
4. **Documentation Rot** - Comments that contradict code, outdated examples

### Consistency Issues
1. **Style Violations** - Deviations from project conventions
2. **Naming Inconsistencies** - Conflicting naming patterns
3. **API Inconsistencies** - Similar operations with different interfaces

---

## Part 2: Strategic Alignment

Evaluate whether the project is headed in the right direction:

### Documentation Currency
Review and update if needed:
- `CLAUDE.md`
- `ARCHITECTURE.md`
- `README.md`

### Progress Assessment
1. **Phase Status** - What phase are we actually in? Does it match docs?
2. **Completed Work** - Is all completed work properly documented?
3. **Next Steps** - Are planned next steps still appropriate?
4. **Blockers** - Are there undocumented blockers or risks?

### Architecture Health
1. **Design Alignment** - Does implementation match stated design?
2. **Technical Debt Trend** - Is debt growing or being addressed?
3. **Abstraction Quality** - Are boundaries clean? Interfaces stable?

### Lessons Learned
1. **Undocumented Learnings** - Discoveries that should be in CLAUDE.md
2. **Tool/Dependency Changes** - Updates to recommended tooling
3. **Pattern Discoveries** - Patterns that worked well or poorly

---

## Output Format

### For Issues Found

Create `docs/ThingsToDo/YYYY-MM-DD_codebase-review.md` with:

```markdown
# Codebase Review - [Date]

## Summary
[Brief overview of findings]

## Critical (Fix Immediately)
- [ ] **[Category]**: Description (file:line)
  - Impact: [What breaks if not fixed]
  - Suggested fix: [Brief approach]

## High Priority
- [ ] **[Category]**: Description (file:line)
  - Impact: [Why this matters]

## Medium Priority
- [ ] **[Category]**: Description (file:line)

## Low Priority / Nice to Have
- [ ] **[Category]**: Description (file:line)

## Strategic Notes
[Any observations about project direction]
```

### For Strategic Updates

If strategic documents need updates:
1. Make the updates directly to the relevant files
2. Note what was updated in the review output
3. If significant decisions are needed, note them for discussion

---

## Review Process

1. **Scan codebase structure** - Understand what exists
2. **Read strategic docs** - Understand stated direction
3. **Compare reality vs documentation** - Find gaps
4. **Deep dive on code** - Look for issues in implementation
5. **Prioritize findings** - Focus on what matters
6. **Update docs** - Keep strategic docs current
7. **Create action items** - Document what needs doing

---

## Execution Notes

- Use `git` commands to understand recent activity if this is a git repo
- Use glob/grep to find patterns across the codebase
- Read key files to understand context before flagging issues
- Be pragmatic - not every style issue needs documenting
- Focus on issues that would actually cause problems
- If the codebase is healthy, say so - don't manufacture issues
