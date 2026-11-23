# Ground-truth rules for the pyright call-hierarchy measurement (GCLI-66, DEC-303)

Fixed 2026-11-23 BEFORE pyright was run on the real repository. Repository: psf/requests at
3c7baaa05ab4aa49cc819ce3a819d260de19c157 (src/requests, 19 files). Python 3.15.2 `ast` enumerated the
symbols and candidate sites (gt1_enumerate.py, seed 303 for the stratified target sample).

## What counts

R1. A syntactic call site is a TRUE call to target T when, in normal runtime flow, the callee expression
    is T's definition, judged by hand from the code around it:
    - `name(...)` where `name` is T imported or defined in scope;
    - `obj.m(...)` where `obj`'s declared or evident type is T's class or a subclass that does not
      override `m`; for a receiver whose evident type is a class that DOES override `m`, the site is a
      true call to the override, and ALSO counted as a polymorphic site for the base `m` (reported
      separately; pyright reports by declared type so a base target may or may not list it);
    - receivers whose type cannot be told by reading the code (a parameter with no annotation or doc
      evidence) are classed UNDECIDABLE, excluded from both recall and precision, and counted.
R2. `Cls(...)` is a call to the class `Cls` (class targets) AND to `Cls.__init__` (init targets), with
    subclasses that do not override `__init__` resolving to the nearest base `__init__`.
R3. `super().m(...)` is a true call to the next base-class `m` in the enclosing class's MRO.
R4. A decorator application `@d` / `@d(...)` is a call to `d`. A function passed or stored without being
    called (callbacks, `hooks`, `functools.partial(f)`, assignment `x = f`) is NOT a call: it is a
    reference only.
R5. Excluded by construction (the ground truth's blind spot, stated, not measured): a call made through
    a variable holding the callable (`f = obj.m; f()`), `getattr(obj, "m")()`, `obj.__dict__` dispatch,
    calls from strings, and calls in files outside src/requests (tests, docs).

## Kinds measured

- symbols: every def/class (exhaustive, from `ast`); a symbol is found if the language server reports it
  with the right name and kind at the right line in `documentSymbol`.
- calls: for each target, pyright `callHierarchy/incomingCalls` result vs the classified sites.
  Recall = true sites found / true sites; precision = true sites found / sites pyright listed.
  A pyright site matches a ground-truth site when the file and line agree (the call's line).
- references: pyright `textDocument/references` (includeDeclaration false) vs every Name/Attribute load of
  the target's name classified by the same rules R1-R3 (the call sites plus passed/stored/imported uses).
- definition-at-call-site: for EVERY syntactic call in the package (986 + 43 decorator sites), does
  `textDocument/definition` at the callee resolve to a location inside src/requests (resolved), outside
  it (external, e.g. urllib3 or the stdlib), or nothing (unresolved)? This is the unresolved-site rate
  the adapter's coverage line would publish.

## Not decided here

Whether a given recall number is good enough: opum-doc rules on a threshold (DEC-303 item 4).
