import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Maximum states per room search during push-optimal BFS. */
const SEARCH_STATES = 250_000;
/** Expanded state budget for difficult rooms during fallback. */
const FALLBACK_STATES = 600_000;

/** Direction vectors: [dx, dy, walkChar, pushChar]. */
const DIRS: readonly [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

export interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

export interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done?: boolean;
}

export interface SolveResult {
  pushes: number;
  moves: string;
}

/**
 * Parse an XSB Sokoban level text into a padded grid representation.
 * Outermost boundary frame is always filled with walls.
 */
export function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;

  for (let y = 0; y < h; y++) {
    const row = rows[y]!;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }

  // Enforce outer boundary as walls
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        wall[y * w + x] = 1;
      }
    }
  }

  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Compute squares from which a single box can be pushed to reach a goal
 * by pulling backwards from the goal squares across open floor.
 */
export function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }

  let head = 0;
  while (head < queue.length) {
    const target = queue[head++]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const boxPos = target - d;
      const playerPos = target - 2 * d;
      if (
        boxPos >= 0 &&
        boxPos < wall.length &&
        playerPos >= 0 &&
        playerPos < wall.length &&
        wall[boxPos] === 0 &&
        wall[playerPos] === 0 &&
        live[boxPos] === 0
      ) {
        live[boxPos] = 1;
        queue.push(boxPos);
      }
    }
  }
  return live;
}

/**
 * Flood-fill reachable floor positions for the player around walls and boxes.
 * Marks visited positions in `seen` with `stamp` and returns the lowest index.
 */
function computeReach(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  start: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array
): number {
  let low = start;
  let top = 0;
  stack[top++] = start;
  seen[start] = stamp;

  while (top > 0) {
    const p = stack[--top]!;
    if (p < low) low = p;

    // Up
    const u = p - w;
    if (wall[u] === 0 && occupied[u] === 0 && seen[u] !== stamp) {
      seen[u] = stamp;
      stack[top++] = u;
    }
    // Down
    const d = p + w;
    if (wall[d] === 0 && occupied[d] === 0 && seen[d] !== stamp) {
      seen[d] = stamp;
      stack[top++] = d;
    }
    // Left
    const l = p - 1;
    if (wall[l] === 0 && occupied[l] === 0 && seen[l] !== stamp) {
      seen[l] = stamp;
      stack[top++] = l;
    }
    // Right
    const r = p + 1;
    if (wall[r] === 0 && occupied[r] === 0 && seen[r] !== stamp) {
      seen[r] = stamp;
      stack[top++] = r;
    }
  }
  return low;
}

/**
 * Test if pushing a box to `t` creates a 2x2 frozen block of walls and boxes
 * containing at least one box not on a goal square.
 */
function isFrozen2x2(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  goal: Uint8Array,
  t: number
): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (
      !(wall[a] || occupied[a]) ||
      !(wall[b] || occupied[b]) ||
      !(wall[c] || occupied[c]) ||
      !(wall[d] || occupied[d])
    ) {
      continue;
    }
    if (
      (occupied[a] && !goal[a]) ||
      (occupied[b] && !goal[b]) ||
      (occupied[c] && !goal[c]) ||
      (occupied[d] && !goal[d])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Deterministic hash key representing the canonical player region and sorted box positions.
 */
function encodeState(boxes: readonly number[], low: number, size: number): number | string {
  if (boxes.length <= 5 && size <= 300) {
    let k = low;
    for (let i = 0; i < boxes.length; i++) {
      k = k * size + boxes[i]!;
    }
    return k;
  }
  return `${low}:${boxes.join(',')}`;
}

/**
 * Shortest path walking for the player between two squares around walls and boxes.
 * Tie-breaking is deterministic (DIRS order).
 */
function walkTo(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  to: number
): string {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;

  queue[tail++] = from;
  prev[from] = from;

  while (head < tail) {
    const p = queue[head++]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] === 0 && occupied[q] === 0 && prev[q] === -1) {
        prev[q] = p;
        how[q] = letter;
        queue[tail++] = q;
      }
    }
  }

  if (prev[to] === -1) {
    throw new Error(`walkTo: square ${to} is unreachable from ${from}`);
  }

  let moves = '';
  for (let p = to; p !== from; p = prev[p]!) {
    moves = how[p]! + moves;
  }
  return moves;
}

/**
 * Track the final player position after executing a sequence of LURD moves.
 */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (let i = 0; i < moves.length; i++) {
    const ch = moves[i]!.toLowerCase();
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * Push-optimal breadth-first search over box pushes.
 * Guaranteed to find the minimum push solution.
 */
export function solvePushOptimal(
  level: Level,
  maxStates: number = SEARCH_STATES
): SolveResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;

  const live = liveSquares(level);
  for (const b of level.boxes) {
    if (!live[b]) return null;
  }

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const isSolved = (boxes: readonly number[]): boolean => {
    for (let i = 0; i < boxes.length; i++) {
      if (!goal[boxes[i]!]) return false;
    }
    return true;
  };

  const statesBoxes: number[][] = [level.boxes];
  const statesPlayer: number[] = [level.player];
  const parent: number[] = [-1];
  const index = new Map<number | string, number>();

  for (const b of level.boxes) occupied[b] = 1;
  const initLow = computeReach(w, wall, occupied, level.player, seen, ++stamp, stack);
  index.set(encodeState(level.boxes, initLow, size), 0);
  for (const b of level.boxes) occupied[b] = 0;

  let found = isSolved(level.boxes) ? 0 : -1;

  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    const boxes = statesBoxes[head]!;
    for (const b of boxes) occupied[b] = 1;
    computeReach(w, wall, occupied, statesPlayer[head]!, seen, ++stamp, stack);
    const reachStamp = stamp;

    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const pushFrom = b - d;
        const pushTo = b + d;

        if (seen[pushFrom] !== reachStamp) continue;
        if (wall[pushTo] || occupied[pushTo] || !live[pushTo]) continue;

        occupied[b] = 0;
        occupied[pushTo] = 1;

        const frozen = isFrozen2x2(w, wall, occupied, goal, pushTo);
        let key: number | string = -1;
        let next: number[] | null = null;

        if (!frozen) {
          next = boxes.slice();
          next[bi] = pushTo;
          next.sort((x, y) => x - y);
          const nextLow = computeReach(w, wall, occupied, b, mark, ++stamp, stack);
          key = encodeState(next, nextLow, size);
        }

        occupied[pushTo] = 0;
        occupied[b] = 1;

        if (frozen || index.has(key)) continue;

        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }

        const nextIdx = statesBoxes.length;
        index.set(key, nextIdx);
        statesBoxes.push(next!);
        statesPlayer.push(b);
        parent.push(head);

        if (isSolved(next!)) {
          found = nextIdx;
          break;
        }
      }
    }

    for (const x of boxes) occupied[x] = 0;
  }

  if (found < 0) return null;

  // Reconstruct path of states
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) {
    path.push(s);
  }
  path.reverse();

  let moves = '';
  let curPlayer = level.player;
  let curBoxes = level.boxes;

  for (const s of path) {
    const nextBoxes = statesBoxes[s]!;
    let from = -1;
    let to = -1;
    for (const b of curBoxes) {
      if (!nextBoxes.includes(b)) {
        from = b;
        break;
      }
    }
    for (const b of nextBoxes) {
      if (!curBoxes.includes(b)) {
        to = b;
        break;
      }
    }
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;

    for (const b of curBoxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, curPlayer, from - d);
    for (const b of curBoxes) occupied[b] = 0;

    moves += dir[3];
    curPlayer = from;
    curBoxes = nextBoxes;
  }

  return { pushes: path.length, moves };
}

/**
 * Decompose a generated level into hallway cut and independent rooms.
 */
export function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);

  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) {
      cut[i] = 1;
    }
  }

  for (const b of boxes) {
    if (cut[b]) return null;
  }

  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];

  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;

    for (let i = 0; i < squares.length; i++) {
      const cur = squares[i]!;
      for (const [dx, dy] of DIRS) {
        const q = cur + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }

  for (const b of boxes) {
    if (part[b] >= 0) rooms[part[b]]!.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] >= 0) rooms[part[g]]!.goals.push(g);
  }

  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) {
    return null;
  }

  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solve level room by room, push-optimally.
 */
export function solveByRooms(level: Level, maxStates: number = SEARCH_STATES): SolveResult | null {
  const rooms = roomsOf(level);
  if (rooms === null) {
    return solvePushOptimal(level, maxStates);
  }

  let player = level.player;
  let pushes = 0;
  let moves = '';

  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other !== room) {
        const blockers = other.done ? other.goals : other.boxes;
        for (const b of blockers) {
          wall[b] = 1;
        }
      }
    }

    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };

    let solved = solvePushOptimal(sub, maxStates);
    if (solved === null && maxStates < FALLBACK_STATES) {
      solved = solvePushOptimal(sub, FALLBACK_STATES);
    }
    if (solved === null) {
      return null;
    }

    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }

  return { pushes, moves };
}

/**
 * Greedy A* fallback over moves to ensure any level can find a valid solution
 * if push-optimal decomposition runs out of budget.
 */
function solveFallbackAStar(level: Level, maxExpansions: number = 200_000): string | null {
  const { w, wall, goals, player } = level;
  const boxes = level.boxes.slice().sort((a, b) => a - b);

  const dist = (b: number): number => {
    let minD = Infinity;
    const bx = b % w;
    const by = Math.floor(b / w);
    for (const g of goals) {
      const d = Math.abs((g % w) - bx) + Math.abs(Math.floor(g / w) - by);
      if (d < minD) minD = d;
    }
    return minD;
  };

  const est = (bs: readonly number[]): number => {
    let sum = 0;
    for (let i = 0; i < bs.length; i++) sum += dist(bs[i]!);
    return sum;
  };

  const key = (p: number, bs: readonly number[]): string => `${p}:${bs.join(',')}`;

  const sp: number[] = [player];
  const sb: number[][] = [boxes];
  const sg: number[] = [0];
  const parent: number[] = [-1];
  const step: string[] = [''];
  const best = new Map<string, number>([[key(player, boxes), 0]]);
  const heap: [number, number, number][] = [[est(boxes), 0, 0]];

  const less = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));

  const pushHeap = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const pIdx = (i - 1) >> 1;
      if (!less(heap[i]!, heap[pIdx]!)) break;
      const tmp = heap[i]!;
      heap[i] = heap[pIdx]!;
      heap[pIdx] = tmp;
      i = pIdx;
    }
  };

  const popHeap = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        const tmp = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  let expanded = 0;
  while (heap.length > 0 && expanded < maxExpansions) {
    const [, g, s] = popHeap();
    if (best.get(key(sp[s]!, sb[s]!)) !== s) continue;
    const bs = sb[s]!;

    let allGoals = true;
    for (const b of bs) {
      if (!goals.includes(b)) {
        allGoals = false;
        break;
      }
    }
    if (allGoals) {
      let moves = '';
      for (let t = s; t > 0; t = parent[t]!) moves = step[t]! + moves;
      return moves;
    }

    expanded++;
    const p = sp[s]!;
    for (const [dx, dy, walkChar, pushChar] of DIRS) {
      const d = dy * w + dx;
      const q = p + d;
      if (wall[q]) continue;

      let nb = bs;
      let move = walkChar;
      const at = bs.indexOf(q);
      if (at >= 0) {
        const beyond = q + d;
        if (wall[beyond] || bs.includes(beyond)) continue;
        nb = bs.slice();
        nb[at] = beyond;
        nb.sort((x, y) => x - y);
        move = pushChar;
      }

      const k = key(q, nb);
      const seen = best.get(k);
      if (seen !== undefined && sg[seen]! <= g + 1) continue;

      const tIdx = sp.length;
      sp.push(q);
      sb.push(nb);
      sg.push(g + 1);
      parent.push(s);
      step.push(move);
      best.set(k, tIdx);
      pushHeap([g + 1 + est(nb), g + 1, tIdx]);
    }
  }

  return null;
}

/**
 * Solve an instance text and return LURD moves.
 */
export function solve(text: string): string {
  const level = parseLevel(text);
  const byRooms = solveByRooms(level, SEARCH_STATES);
  if (byRooms !== null) {
    return byRooms.moves;
  }
  const wholeOptimal = solvePushOptimal(level, FALLBACK_STATES);
  if (wholeOptimal !== null) {
    return wholeOptimal.moves;
  }
  const fallback = solveFallbackAStar(level, 200_000);
  if (fallback !== null) {
    return fallback;
  }
  return '';
}

// Main CLI runner
const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(inputDir).sort()) {
  const levelPath = join(inputDir, id, 'level.txt');
  const levelText = readFileSync(levelPath, 'utf8');
  const solution = solve(levelText);
  const outDir = join(outputDir, id);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'solution.txt'), `${solution}\n`);
}
