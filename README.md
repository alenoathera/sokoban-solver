[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/alenoathera/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/alenoathera/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# Sokoban Push-Optimal Solver

A fast, dependency-free, push-optimal Sokoban solver designed for make.fun's [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121) competition.

## Overview

The solver solves Sokoban instances by leveraging topological room decomposition:
1. **Live Square Analysis**: Identifies squares from which a box alone can be pushed onto any goal square by backward BFS pulls. Dead squares (from which no goal can be reached) are detected immediately.
2. **Room Decomposition**: Isolates the hallway separating the rooms and cuts dead hallway squares. Connected components containing boxes and matching goals form independent rooms. Because boxes never leave their respective rooms, the level's push-optimal count $P^*$ is the sum of its independent room optima.
3. **Push-Optimal BFS with Deadlock Pruning**: Each room is solved sequentially using push-optimal breadth-first search. Two key deadlock pruning rules keep search states minimal:
   - *Dead Square Pruning*: Never pushes a box onto a square that cannot reach any goal.
   - *Frozen 2×2 Block Pruning*: Prunes any move creating an immovable 2×2 block of walls and boxes with an off-goal box.
4. **Move Reconstruction**: Full player step sequences (LURD) are reconstructed using BFS shortest-path player walks between pushes. The player's finishing position carries over into subsequent rooms.
5. **Robust Fallbacks**: If room decomposition is inapplicable or exceeds state budgets, the solver falls back to whole-level push search and greedy heuristic A* search to ensure a valid solution is always provided.

## How to Run Locally

```bash
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Links

- **Bounty Page**: https://make.fun/bounty/sokoban-solver-01-run-20261121
- **Referral**: Referral code `grdyyq5p` ([https://make.fun/r/grdyyq5p](https://make.fun/r/grdyyq5p))

## License

[MIT](LICENSE)
