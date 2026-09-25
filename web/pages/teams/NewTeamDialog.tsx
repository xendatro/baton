import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { DEFAULT_TEAM_COLOR } from '@shared/constants';
import { createTeamInputSchema, teamSlugFromName } from '@shared/schemas/teams';
import { FormError } from '@web/components/auth/FormField';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { isApiError } from '@web/lib/api';
import { fieldErrors } from '@web/lib/forms';
import { useShellActionHandler } from '@web/lib/shellActions';
import { useCreateTeam } from './api';
import { TeamFields, type TeamFieldErrors, type TeamFieldValues } from './TeamFields';

/**
 * The "New team" dialog (shell action `team.create`): name, URL, description, icon and color.
 * The URL follows the name until edited; the server adds a number if a derived one is taken.
 */
export default function NewTeamDialog() {
  const [open, setOpen] = useState(false);
  useShellActionHandler('team.create', () => setOpen(true));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        {open ? <NewTeamForm onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function NewTeamForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const createTeam = useCreateTeam();
  const [values, setValues] = useState<TeamFieldValues>({
    name: '',
    slug: '',
    description: '',
    icon: null,
    color: DEFAULT_TEAM_COLOR,
  });
  const [slugEdited, setSlugEdited] = useState(false);
  const [errors, setErrors] = useState<TeamFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const derivedSlug = values.name.trim() ? teamSlugFromName(values.name) : '';
  const shownSlug = slugEdited ? values.slug : derivedSlug;

  const submit = () => {
    const parsed = createTeamInputSchema.safeParse({
      name: values.name,
      ...(slugEdited ? { slug: values.slug } : {}),
      description: values.description,
      icon: values.icon,
      color: values.color,
    });
    if (!parsed.success) {
      setErrors(fieldErrors<keyof TeamFieldValues>(parsed.error));
      return;
    }
    setErrors({});
    setFormError(null);
    createTeam.mutate(parsed.data, {
      onSuccess: (team) => {
        toast.success(`Created ${team.name}`);
        onDone();
        void navigate(`/t/${team.slug}`);
      },
      onError: (error) => {
        if (isApiError(error) && error.code === 'conflict') {
          setSlugEdited(true);
          setValues((current) => ({ ...current, slug: shownSlug }));
          setErrors({ slug: error.message });
        } else if (isApiError(error) && error.code === 'validation_failed') {
          setErrors(error.fieldErrors);
        } else {
          setFormError(error.message);
        }
      },
    });
  };

  return (
    <form
      className="grid gap-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Create a team</DialogTitle>
        <DialogDescription>
          Teams hold projects. You’ll be the owner and can invite people with a link.
        </DialogDescription>
      </DialogHeader>
      <TeamFields
        values={{ ...values, slug: shownSlug }}
        onChange={(patch) => {
          if (patch.slug !== undefined) setSlugEdited(true);
          setValues((current) => ({ ...current, ...patch }));
          setErrors((current) => {
            const next = { ...current };
            for (const key of Object.keys(patch)) delete next[key as keyof TeamFieldValues];
            return next;
          });
        }}
        errors={errors}
        disabled={createTeam.isPending}
        autoFocusName
        slugHint={
          slugEdited
            ? 'Lowercase letters, digits and dashes.'
            : 'Based on the name. If it’s taken, a number is added.'
        }
      />
      <FormError message={formError} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={createTeam.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={createTeam.isPending || !values.name.trim()}>
          {createTeam.isPending ? <Spinner /> : null}
          Create team
        </Button>
      </DialogFooter>
    </form>
  );
}
