import type { JSX } from 'react';

/**
 * Round avatar with initials over a 135deg gradient. Matches the `.av` /
 * `.av.lg` design CSS — `linear-gradient(135deg, user.avatar || '#3a4a8a',
 * '#1a223f')` background, serif initials. The size variants land at 22 (sm),
 * 30 (md, default) and 54 (lg). The `lg` size also bumps the serif to 20.
 *
 * `sm` is not in the design CSS but is documented in the rebuild checklist so
 * the avatar can render in dense rows; it reuses the same 12px serif as `md`.
 */

export type AvatarSize = 'sm' | 'md' | 'lg';

export type AvatarUser = {
  name: string;
  avatar?: string;
};

export type AvatarProps = {
  user: AvatarUser;
  size?: AvatarSize;
};

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((token) => token.charAt(0).toUpperCase())
    .join('');
}

const SIZES: Record<AvatarSize, { px: number; font: number }> = {
  sm: { px: 22, font: 11 },
  md: { px: 30, font: 12 },
  lg: { px: 54, font: 20 },
};

export function Avatar({ user, size = 'md' }: AvatarProps): JSX.Element {
  const { px, font } = SIZES[size];
  const seed = user.avatar ?? '#3a4a8a';
  const className = ['av', size === 'lg' ? 'lg' : size === 'sm' ? 'sm' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      aria-label={user.name}
      style={{
        width: px,
        height: px,
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'var(--serif)',
        fontWeight: 500,
        fontSize: font,
        color: '#fff',
        flexShrink: 0,
        background: `linear-gradient(135deg, ${seed}, #1a223f)`,
        border: '1px solid var(--line-2)',
      }}
    >
      {initials(user.name)}
    </div>
  );
}
