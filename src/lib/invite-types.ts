import type { Color } from './xiangqi';
import type { RoomSettings, RoomStatus } from './server/types';

export interface InvitePreview {
  code: string;
  opponent: { displayName: string; color: Color };
  settings: RoomSettings;
  status: RoomStatus;
  canJoin: boolean;
}
