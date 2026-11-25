/**
 * Items players can carry (one at a time, see CONFIG.interaction.maxHeldItems)
 * and discoveries (hidden objects; per-player, recorded in profiles + World Memory).
 */

export type ItemId = 'apple' | 'wrench' | 'wildflower' | 'smooth_pebble' | 'pinecone' | 'seashell' | 'paper_lantern';

export interface ItemDef {
  id: ItemId;
  name: string;
  description: string;
  /** Hint for the procedural renderer when held in hand. */
  shape: 'sphere' | 'tool' | 'flower' | 'pebble' | 'cone' | 'shell' | 'lantern';
  color: string;
}

export const ITEMS: Readonly<Record<ItemId, ItemDef>> = {
  apple: { id: 'apple', name: 'Apple', description: 'Crisp, red, and slightly bruised on one side.', shape: 'sphere', color: '#b8453a' },
  wrench: { id: 'wrench', name: 'Wrench', description: 'Well-worn. Someone scratched initials into the handle.', shape: 'tool', color: '#8d8f93' },
  wildflower: { id: 'wildflower', name: 'Wildflower', description: 'A small blue flower from the garden beds.', shape: 'flower', color: '#7c8fd1' },
  smooth_pebble: { id: 'smooth_pebble', name: 'Smooth Pebble', description: 'Worn perfectly flat by the sea. Good for skipping.', shape: 'pebble', color: '#9c968c' },
  pinecone: { id: 'pinecone', name: 'Pinecone', description: 'Fell from one of the tallest pines in the Woods.', shape: 'cone', color: '#7a5634' },
  seashell: { id: 'seashell', name: 'Seashell', description: 'If you hold it to your ear you hear… the island.', shape: 'shell', color: '#e9cdb8' },
  paper_lantern: { id: 'paper_lantern', name: 'Paper Lantern', description: 'Glows faintly, even when unlit.', shape: 'lantern', color: '#e7b25c' },
};

export type DiscoveryId =
  | 'mossy_coin'
  | 'carved_owl'
  | 'music_box'
  | 'old_compass'
  | 'message_bottle'
  | 'stone_inscription';

export interface DiscoveryDef {
  id: DiscoveryId;
  name: string;
  /** Text revealed when found. */
  text: string;
}

export const DISCOVERIES: Readonly<Record<DiscoveryId, DiscoveryDef>> = {
  mossy_coin: { id: 'mossy_coin', name: 'Mossy Coin', text: 'A coin from no country you know. One side shows a fountain; the other, an arch.' },
  carved_owl: { id: 'carved_owl', name: 'Carved Owl', text: 'Someone carved an owl into this trunk long ago. Its eyes face the north edge of the island.' },
  music_box: { id: 'music_box', name: 'Music Box', text: 'It plays three notes, then stops. Three, always three.' },
  old_compass: { id: 'old_compass', name: 'Old Compass', text: 'The needle ignores north. It points toward the standing stones.' },
  message_bottle: { id: 'message_bottle', name: 'Message in a Bottle', text: '"If you are reading this, find two friends and wake the stones together."' },
  stone_inscription: { id: 'stone_inscription', name: 'Stone Inscription', text: 'WHAT ONE CANNOT WAKE, MANY MAY.' },
};
