import type { ReactNode } from 'react';
import { LIMITS } from '@shared/constants';
import { FormField } from '@web/components/auth/FormField';
import { ColorPicker } from '@web/components/pickers/ColorPicker';
import { EmojiPicker } from '@web/components/pickers/EmojiPicker';
import { Input } from '@web/components/ui/input';
import { Textarea } from '@web/components/ui/textarea';
import { TeamIcon } from './TeamIcon';

export interface TeamFieldValues {
  name: string;
  slug: string;
  description: string;
  icon: string | null;
  color: string;
}

export type TeamFieldErrors = Partial<Record<keyof TeamFieldValues, string>>;

export interface TeamFieldsProps {
  values: TeamFieldValues;
  onChange: (patch: Partial<TeamFieldValues>) => void;
  errors?: TeamFieldErrors;
  disabled?: boolean;
  /** Helper text under the URL field. */
  slugHint?: ReactNode;
  autoFocusName?: boolean;
}

/** Name, URL, description, icon and color of a team (the New team dialog and General settings). */
export function TeamFields({
  values,
  onChange,
  errors = {},
  disabled = false,
  slugHint,
  autoFocusName = false,
}: TeamFieldsProps) {
  return (
    <div className="grid gap-4">
      <div className="flex items-end gap-3">
        <EmojiPicker
          value={values.icon}
          onChange={(icon) => onChange({ icon })}
          label="Team icon"
          disabled={disabled}
        >
          <button
            type="button"
            disabled={disabled}
            title="Change icon"
            aria-label={values.icon ? `Team icon ${values.icon}, change it` : 'Choose a team icon'}
            className="shrink-0 rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
          >
            <TeamIcon
              icon={values.icon}
              name={values.name || 'Team'}
              color={values.color}
              size="md"
              className="transition-transform hover:scale-105"
            />
          </button>
        </EmojiPicker>
        <FormField label="Name" error={errors.name} className="flex-1">
          {(field) => (
            <Input
              {...field}
              value={values.name}
              onChange={(event) => onChange({ name: event.target.value })}
              maxLength={LIMITS.teamName.max}
              placeholder="Acme"
              autoComplete="off"
              autoFocus={autoFocusName}
              disabled={disabled}
            />
          )}
        </FormField>
      </div>

      <FormField label="URL" error={errors.slug} hint={slugHint}>
        {(field) => (
          <div className="flex rounded-md shadow-xs">
            <span className="inline-flex items-center rounded-l-md border border-r-0 bg-muted px-2.5 font-mono text-sm text-muted-foreground">
              /t/
            </span>
            <Input
              {...field}
              value={values.slug}
              onChange={(event) => onChange({ slug: event.target.value.toLowerCase() })}
              maxLength={LIMITS.teamSlug.max}
              placeholder="acme"
              autoComplete="off"
              spellCheck={false}
              className="rounded-l-none font-mono shadow-none"
              disabled={disabled}
            />
          </div>
        )}
      </FormField>

      <FormField
        label="Description"
        error={errors.description}
        hint={`Optional. Shown on the team page (${values.description.length}/${LIMITS.teamDescription.max}).`}
      >
        {(field) => (
          <Textarea
            {...field}
            value={values.description}
            onChange={(event) => onChange({ description: event.target.value })}
            maxLength={LIMITS.teamDescription.max}
            rows={3}
            placeholder="What does this team work on?"
            disabled={disabled}
          />
        )}
      </FormField>

      <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-medium">Accent color</p>
          <p className="text-xs text-muted-foreground">Used for the team’s icon and highlights.</p>
        </div>
        <ColorPicker
          value={values.color}
          onChange={(color) => onChange({ color })}
          label="Team color"
          disabled={disabled}
          align="end"
        />
      </div>
      {errors.color ? (
        <p role="alert" className="-mt-2 text-xs text-destructive">
          {errors.color}
        </p>
      ) : null}
      {errors.icon ? (
        <p role="alert" className="-mt-2 text-xs text-destructive">
          {errors.icon}
        </p>
      ) : null}
    </div>
  );
}
