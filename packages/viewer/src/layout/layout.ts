// Typed access to office.json (spec §6). Grid units: x right-down, y left-down, z up.

import raw from './office.json' with { type: 'json' };

export type Facing = 'n' | 's' | 'e' | 'w';
export type Pose = 'sit' | 'stand';
export type SpotZone = 'board' | 'library' | 'armchair' | 'archive' | 'window' | 'server' | 'lab' | 'whiteboard' | 'lounge' | 'pingpong' | 'door';

export interface Spot {
  x: number;
  y: number;
  face: Facing;
  pose: Pose;
  /** Café table this spot belongs to: people at the same table chat with each other. */
  group?: string;
}

export interface Desk {
  id: string;
  x: number;
  y: number;
  w: number;
  d: number;
  chair: [number, number];
  overflow?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  d: number;
}

export interface OfficeLayout {
  version: number;
  grid: { w: number; d: number; wallHeight: number };
  rugs: Array<Rect & { zone: string; color: string }>;
  desks: Desk[];
  leadDesk: Desk;
  board: { x0: number; x1: number; z0: number; z1: number };
  window: { x0: number; x1: number; z0: number; z1: number };
  shelves: Array<{ y0: number; y1: number }>;
  armchair: { x: number; y: number };
  archive: Array<{ y0: number; y1: number }>;
  racks: Array<{ x0: number; x1: number }>;
  bench: Rect;
  whiteboard: { x0: number; x1: number; y: number };
  /** Ping pong table: exactly two idle people play (D22). */
  pingpong: Rect;
  lounge: { sofa: Rect; coffee: Rect; cooler: { x: number; y: number }; tables: Array<{ x: number; y: number }> };
  boss: {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    doorGap: [number, number];
    desk: Rect;
    chair: [number, number];
    label: string;
  };
  plants: Array<[number, number]>;
  spots: Record<SpotZone, Spot[]>;
}

type RawSpot = [number, number, string, string?, string?];

function parse(json: typeof raw): OfficeLayout {
  const spots = {} as Record<SpotZone, Spot[]>;
  for (const [zone, list] of Object.entries(json.spots) as Array<[SpotZone, RawSpot[]]>) {
    spots[zone] = list.map(([x, y, face, pose, group]) => ({ x, y, face: face as Facing, pose: (pose ?? 'stand') as Pose, ...(group ? { group } : {}) }));
  }
  return { ...(json as unknown as Omit<OfficeLayout, 'spots'>), spots };
}

export const OFFICE: OfficeLayout = parse(raw);

/** Unit vector (grid x, grid y) a facing points to. */
export function faceVector(face: Facing): [number, number] {
  switch (face) {
    case 'n':
      return [0, -1];
    case 's':
      return [0, 1];
    case 'e':
      return [1, 0];
    case 'w':
      return [-1, 0];
  }
}
