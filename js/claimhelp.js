// Claim help (settings.claimHelp): which legal moves player 0 has right now and which
// tiles they use. Hints only, never strategy. Pure, no DOM; unit-tested.

const HUMAN = 0;

const emptyHelp = () => ({
  hint: '',
  buttons: { hu: false, kong: false, pong: false, chi: false },
  tilesFor: { pong: [], kong: [], chi: [], hu: [] },
  union: [],
  meldIndexFor: { kong: null },
  kongs: [], // one per Kong option: { tile, kind, indexes, meldIndex }
  claimTile: null,
  from: null,
  target: null, // where the claimed tile sits: { kind: 'discard'|'meld', player, index }
});

// Indexes into `hand` for `codes`, never reusing an index (hands may hold duplicates).
function pickIndexes(hand, codes, used = new Set()) {
  const out = [];
  for (const code of codes) {
    const i = hand.findIndex((t, j) => t === code && !used.has(j));
    if (i < 0) return [];
    used.add(i);
    out.push(i);
  }
  return out.sort((a, b) => a - b);
}

// "Pong", "Pong, or Chi (2 ways)", "Kong, Pong, or Chi".
function listWords(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')}, or ${words.at(-1)}`;
}

/**
 * claimHelp(state, actions) for player 0. `actions` is legalActions(state, 0).
 * Hand indexes refer to state.players[0].hand (sorted).
 */
export function claimHelp(state, actions) {
  const help = emptyHelp();
  if (!state || !actions || !actions.length) return help;
  const { hand, melds } = state.players[HUMAN];
  const has = (type) => actions.some((a) => a.type === type);
  for (const b of Object.keys(help.buttons)) help.buttons[b] = has(b);
  if (help.buttons.hu) help.tilesFor.hu = hand.map((_, i) => i);

  if (state.phase === 'claim' && state.claim) {
    const { tile, from, robKong } = state.claim;
    help.claimTile = tile;
    help.from = from;
    if (robKong) {
      const index = state.players[from].melds.findIndex((m) => m.type === 'pong' && m.tiles[0] === tile);
      help.target = index >= 0 ? { kind: 'meld', player: from, index } : null;
    } else {
      const index = state.players[from].discards.lastIndexOf(tile);
      help.target = index >= 0 ? { kind: 'discard', player: from, index } : null;
    }
    if (help.buttons.kong) {
      const indexes = pickIndexes(hand, [tile, tile, tile]);
      help.tilesFor.kong = indexes;
      help.kongs = [{ tile, kind: 'claimed', indexes, meldIndex: null }];
    }
    if (help.buttons.pong) help.tilesFor.pong = pickIndexes(hand, [tile, tile]);
    help.tilesFor.chi = actions.filter((a) => a.type === 'chi').map((a) => pickIndexes(hand, a.tiles));

    const words = [];
    if (help.buttons.kong) words.push('Kong');
    if (help.buttons.pong) words.push('Pong');
    const chiCount = help.tilesFor.chi.length;
    if (chiCount) words.push(chiCount > 1 ? `Chi (${chiCount} ways)` : 'Chi');
    if (robKong && help.buttons.hu) help.hint = 'You can rob this Kong to win';
    else if (help.buttons.hu) {
      help.hint = 'You can win with this tile: Hu!' + (words.length ? ` You could also ${listWords(words)}` : '');
    } else if (words.length) help.hint = `You can ${listWords(words)}`;
  } else if (state.phase === 'turn' && state.turn === HUMAN) {
    for (const a of actions.filter((x) => x.type === 'kong')) {
      if (a.kind === 'concealed') {
        help.kongs.push({ tile: a.tile, kind: a.kind, indexes: pickIndexes(hand, [a.tile, a.tile, a.tile, a.tile]), meldIndex: null });
      } else {
        const meldIndex = melds.findIndex((m) => m.type === 'pong' && m.tiles[0] === a.tile);
        help.kongs.push({ tile: a.tile, kind: a.kind, indexes: pickIndexes(hand, [a.tile]), meldIndex: meldIndex >= 0 ? meldIndex : null });
      }
    }
    help.tilesFor.kong = [...new Set(help.kongs.flatMap((k) => k.indexes))].sort((a, b) => a - b);
    help.meldIndexFor.kong = help.kongs.find((k) => k.meldIndex !== null)?.meldIndex ?? null;
    if (help.buttons.hu) {
      help.hint = 'Your hand is complete: Hu!' + (help.buttons.kong ? ' You could also declare a Kong' : '');
    } else if (help.buttons.kong) help.hint = 'You can declare a Kong';
  }

  help.union = [...new Set([...help.tilesFor.kong, ...help.tilesFor.pong, ...help.tilesFor.chi.flat()])].sort((a, b) => a - b);
  return help;
}
