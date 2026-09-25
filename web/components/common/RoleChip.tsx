import { Chip } from './Chip';

export interface RoleChipProps {
  role: { name: string; color: string | null };
  /** Prefix the name with `@` (as in a mention). */
  mention?: boolean;
  className?: string;
}

export function RoleChip({ role, mention = false, className }: RoleChipProps) {
  const name = mention && !role.name.startsWith('@') ? `@${role.name}` : role.name;
  return (
    <Chip color={role.color} className={className} title={`Role: ${role.name}`}>
      {name}
    </Chip>
  );
}
