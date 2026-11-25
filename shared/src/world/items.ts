/**
 * Items players can carry (one at a time, see CONFIG.interaction.maxHeldItems)
 * and discoveries (hidden objects; per-player, recorded in profiles + World Memory).
 */

export type ItemId =
  | 'apple'
  | 'wrench'
  | 'wildflower'
  | 'smooth_pebble'
  | 'pinecone'
  | 'seashell'
  | 'paper_lantern'
  // Café drinks (held only; never part of the collection — see activities.ts DRINKS)
  | 'cup_coffee'
  | 'cup_tea'
  | 'cup_cocoa'
  | 'cup_special'
  // General Store curiosities (activities.ts CURIOSITIES)
  | 'postcard'
  | 'brass_key'
  | 'tin_whistle'
  | 'glass_marble'
  | 'ribbon'
  | 'seed_packet'
  | 'spinning_top'
  | 'pressed_leaf'
  | 'candle_stub';

export interface ItemDef {
  id: ItemId;
  name: string;
  description: string;
  /** Hint for the procedural renderer when held in hand. */
  shape: 'sphere' | 'tool' | 'flower' | 'pebble' | 'cone' | 'shell' | 'lantern' | 'cup' | 'card' | 'key' | 'trinket';
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
  cup_coffee: { id: 'cup_coffee', name: 'Coffee', description: 'A warm cup from the café. Sip it while it lasts.', shape: 'cup', color: '#efe4cf' },
  cup_tea: { id: 'cup_tea', name: 'Tea', description: 'Steaming, in a chipped blue cup.', shape: 'cup', color: '#8fb0b4' },
  cup_cocoa: { id: 'cup_cocoa', name: 'Cocoa', description: 'Thick and sweet, in a big round mug.', shape: 'cup', color: '#c46f4f' },
  cup_special: { id: 'cup_special', name: 'Today’s special', description: 'Whatever the chalkboard says today.', shape: 'cup', color: '#d1a23f' },
  postcard: { id: 'postcard', name: 'Postcard', description: 'A painted view of the island from the sea. Nobody has written on it yet.', shape: 'card', color: '#e9cdb8' },
  brass_key: { id: 'brass_key', name: 'Brass Key', description: 'Opens nothing anyone knows of. Yet.', shape: 'key', color: '#c9a23f' },
  tin_whistle: { id: 'tin_whistle', name: 'Tin Whistle', description: 'Plays three notes well and the rest bravely.', shape: 'tool', color: '#a9b0b4' },
  glass_marble: { id: 'glass_marble', name: 'Glass Marble', description: 'A twist of sea-green inside clear glass.', shape: 'trinket', color: '#7fb0a4' },
  ribbon: { id: 'ribbon', name: 'Ribbon', description: 'A length of dusty-rose ribbon, neatly rolled.', shape: 'trinket', color: '#c79195' },
  seed_packet: { id: 'seed_packet', name: 'Seed Packet', description: '“Mixed meadow. Plant somewhere kind.”', shape: 'card', color: '#9fae8c' },
  spinning_top: { id: 'spinning_top', name: 'Spinning Top', description: 'Painted wood. Spins longer than you would think.', shape: 'trinket', color: '#b0563d' },
  pressed_leaf: { id: 'pressed_leaf', name: 'Pressed Leaf', description: 'An oak leaf pressed flat between pages, years ago.', shape: 'card', color: '#c9a23f' },
  candle_stub: { id: 'candle_stub', name: 'Candle Stub', description: 'Half a beeswax candle. Smells of honey.', shape: 'trinket', color: '#f1d27a' },
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
