// Built-in sample positions for an account with no mistakes to drill yet. They are never stored with your
// drills, never scheduled for review and never counted in reports, streaks or minutes. They only make sure a
// first session can still finish with a completed drill.
const base = { box: null, due: null, history: [], sample: true, side: 'w', bestMate: null };

export const SAMPLE_DRILLS = [
  { ...base, id: 'sample:backrank', pattern: 'tactic', fen: '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1', ply: 40,
    bestUci: 'e1e8', bestSan: 'Re8#', bestPv: ['Re8#'], bestCp: 1000, bestMate: 1, cpAfter: 150,
    wpBefore: 99, wpLoss: 40, playedUci: 'g1h1', playedSan: 'Kh1',
    explain: 'You had checkmate in 1. Re8# was the move. The black king has no escape squares behind its own pawns.' },
  { ...base, id: 'sample:fork', pattern: 'tactic', fen: 'r3k3/8/4N3/8/8/8/8/4K3 w - - 0 1', ply: 40,
    bestUci: 'e6c7', bestSan: 'Nc7+', bestPv: ['Nc7+', 'Kd7', 'Nxa8'], bestCp: 400, cpAfter: -200,
    wpBefore: 81, wpLoss: 49, playedUci: 'e1f2', playedSan: 'Kf2',
    explain: 'Nc7+ forks the king and the rook. You played Kf2.' },
  { ...base, id: 'sample:freequeen', pattern: 'tactic', fen: 'r1b1k2r/ppp2ppp/2n5/3qp3/8/2N2N2/PPPP1PPP/R1BQ1RK1 w kq - 0 1', ply: 40,
    bestUci: 'c3d5', bestSan: 'Nxd5', bestPv: ['Nxd5'], bestCp: 900, cpAfter: 0,
    wpBefore: 96, wpLoss: 46, playedUci: 'd2d3', playedSan: 'd3',
    explain: 'Nxd5 wins the queen for free. You played d3.' },
];

export const sampleById = (id) => SAMPLE_DRILLS.find((d) => d.id === id) || null;
