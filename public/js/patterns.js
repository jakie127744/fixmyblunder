// The five named patterns the MVP ships with. Plain code classifies; templates phrase it.
export const PATTERNS = {
  hanging: {
    id: 'hanging', name: 'Hanging pieces',
    blurb: 'A piece was left with no defender, or moved to a square where it could be taken.',
    lesson: 'Before every move, name each of your pieces that nobody defends. If your opponent can attack one of them with a pawn or a knight, fix that first. Most hung pieces happen in positions that were already good.',
    idea: 'Which of your pieces is attacked, and is it defended? Fix that before anything else.',
  },
  tactic: {
    id: 'tactic', name: 'Missed tactics',
    blurb: 'A stronger move was on the board and you played something else.',
    lesson: 'Before a quiet move, check every capture, every check and every threat, yours first and then theirs. Forcing moves are where games are decided, so look at them first.',
    idea: 'Look at checks, captures and threats first. One of them wins something.',
  },
  endgame: {
    id: 'endgame', name: 'Endgame technique',
    blurb: 'Winning or equal endings that slipped after most pieces came off.',
    lesson: 'In endings, king activity and passed pawns matter more than anything. Ask where your king should go and which pawn can run. Do not rush, there is rarely a threat to react to.',
    idea: 'In an ending, bring the king in and look at the pawns. What is the most useful improving move?',
  },
  king: {
    id: 'king', name: 'King safety',
    blurb: 'A move weakened your king or ignored an attack building against it.',
    lesson: 'Before moving a pawn near your king, ask what squares it stops guarding. Before you attack, ask whether their last move created a threat against you.',
    idea: 'What does your opponent threaten against your king right now? Answer that first.',
  },
  advantage: {
    id: 'advantage', name: 'Throwing away wins',
    blurb: 'A winning position slipped away through a quiet move.',
    lesson: 'When you are winning, trade pieces and remove counterplay instead of hunting for more. Before each move ask what your opponent wants, and take it away. Simple and safe wins the game.',
    idea: 'You are better here. Which move keeps everything safe and takes away their best idea?',
  },
  positional: {
    id: 'positional', name: 'Positional slips',
    blurb: 'A quieter move was clearly better, with no immediate tactic involved.',
    lesson: 'Not every mistake loses a piece. Look for your worst-placed piece and improve it, and ask which pawn break or open file helps you most. Small improvements add up.',
    idea: 'No tactic here. Which piece is worst placed, and where does it belong?',
  },
  time: {
    id: 'time', name: 'Time trouble',
    blurb: 'Mistakes made with very little time left on your clock.',
    lesson: 'Mistakes pile up when the clock runs low. Decide your time budget by move 15 and use quick, forcing moves first. Spend your time on the two or three moves that matter.',
    idea: 'This was played with almost no time. Slow down and find the safest strong move.',
  },
};
export const PATTERN_ORDER = ['hanging', 'tactic', 'advantage', 'endgame', 'king', 'time', 'positional'];
export const pat = (id) => PATTERNS[id] || PATTERNS.tactic;
