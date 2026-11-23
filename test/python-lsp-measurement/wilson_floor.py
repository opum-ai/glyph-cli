"""Wilson 95% lower-bound table for the DEC-303 (a1) gate (GCLI-68, ADR 0008). `python3 -I wilson_floor.py`.

The formula is the one in score.py and union.py (z = 1.96), copied here so the table needs no pyright output.
"""
import math


def wilson(k, n, z=1.96):
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    a = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (max(0.0, (c - a) / d), min(1.0, (c + a) / d))


print('Recall: for n true sites, the fewest hits k whose Wilson lower bound is >= 0.8, and whether k/n >= 0.9')
print('n    min k   k/n     lower(min k)  ceil(0.9n)  lower(ceil(0.9n))  observed 0.9 alone meets the bound')
for n in list(range(55, 71)) + [80, 100]:
    k = next(kk for kk in range(n + 1) if wilson(kk, n)[0] >= 0.8)
    c = -(-9 * n // 10)
    print(f'{n:<4} {k:<7} {k / n:.4f}  {wilson(k, n)[0]:.4f}        {c:<11} {wilson(c, n)[0]:.4f}             {"yes" if wilson(c, n)[0] >= 0.8 else "no"}')
print()
print('Recall of exactly 0.9 (k = 0.9n, not necessarily a whole number of hits): lower bound by n')
for n in range(58, 66):
    print(f'n = {n}  k = {0.9 * n:.1f}  lower {wilson(0.9 * n, n)[0]:.4f}  {"meets 0.8" if wilson(0.9 * n, n)[0] >= 0.8 else "below 0.8"}')
print()
print('Specific values')
for k, n in [(54, 60), (55, 60), (55, 61), (56, 62), (63, 70), (59, 65), (58, 65), (60, 60), (10, 10)]:
    lo, hi = wilson(k, n)
    print(f'{k}/{n} = {k / n:.4f}  Wilson {lo:.4f}-{hi:.4f}')
print()
print('Information only: fewest emitted edges n (all correct) for which the Wilson lower bound on precision is >= 0.95')
n = next(n for n in range(1, 1000) if wilson(n, n)[0] >= 0.95)
print(f'n = {n}  (lower bound {wilson(n, n)[0]:.4f}); at n = {n - 1}: {wilson(n - 1, n - 1)[0]:.4f}')
