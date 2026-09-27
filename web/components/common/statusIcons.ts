import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  CirclePauseIcon,
  CircleXIcon,
  ContrastIcon,
  DiamondIcon,
  FlagIcon,
  SquareIcon,
  StarIcon,
  TriangleIcon,
  type LucideIcon,
} from 'lucide-react';
import type { StatusIconShape } from '@shared/constants';

/** The lucide icon of each status shape, and its name for pickers and screen readers. */
export const STATUS_ICON_SHAPES: Record<StatusIconShape, { icon: LucideIcon; label: string }> = {
  circle: { icon: CircleIcon, label: 'Circle' },
  'dashed-circle': { icon: CircleDashedIcon, label: 'Dashed circle' },
  'half-circle': { icon: ContrastIcon, label: 'Half circle' },
  'dot-circle': { icon: CircleDotIcon, label: 'Circle with a dot' },
  'check-circle': { icon: CircleCheckIcon, label: 'Check' },
  'x-circle': { icon: CircleXIcon, label: 'Cross' },
  'pause-circle': { icon: CirclePauseIcon, label: 'Pause' },
  square: { icon: SquareIcon, label: 'Square' },
  triangle: { icon: TriangleIcon, label: 'Triangle' },
  diamond: { icon: DiamondIcon, label: 'Diamond' },
  star: { icon: StarIcon, label: 'Star' },
  flag: { icon: FlagIcon, label: 'Flag' },
};
